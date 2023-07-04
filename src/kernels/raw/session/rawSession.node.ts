// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Kernel, KernelMessage, ServerConnection, Session } from '@jupyterlab/services';
import { ISignal, Signal } from '@lumino/signaling';
import uuid from 'uuid/v4';
import { getTelemetrySafeErrorMessageFromPythonTraceback } from '../../../platform/errors/errorUtils';
import { traceVerbose, traceInfoIfCI, traceError, traceWarning } from '../../../platform/logging';
import { IDisposable, Resource } from '../../../platform/common/types';
import { createDeferred, raceTimeout } from '../../../platform/common/utils/async';
import { KernelConnectionTimeoutError } from '../../errors/kernelConnectionTimeoutError';
import { Telemetry } from '../../../telemetry';
import {
    INewSessionWithSocket,
    ISessionWithSocket,
    KernelConnectionMetadata,
    KernelSocketInformation,
    LocalKernelConnectionMetadata
} from '../../types';
import { IKernelLauncher, IKernelProcess } from '../types';
import { OldRawKernel, RawKernelConnection, createRawKernel } from './rawKernel.node';
import { sendKernelTelemetryEvent } from '../../telemetry/sendKernelTelemetryEvent';
import { noop } from '../../../platform/common/utils/misc';
import { getNameOfKernelConnection } from '../../helpers';
import { CancellationToken, Uri } from 'vscode';
import { trackKernelResourceInformation } from '../../telemetry/helper';

/*
RawSession class implements a jupyterlab ISession object
This provides enough of the ISession interface so that our direct
ZMQ Kernel connection can pretend to be a jupyterlab Session
*/
export class OldRawSession implements ISessionWithSocket {
    public isDisposed: boolean = false;
    public readonly kernelConnectionMetadata: KernelConnectionMetadata;
    private isDisposing?: boolean;

    // Note, ID is the ID of this session
    // ClientID is the ID that we pass in messages to the kernel
    // and is also the clientID of the active kernel
    private _id: string;
    private _clientID: string;
    private _kernel: OldRawKernel;
    private readonly _statusChanged: Signal<this, KernelMessage.Status>;
    private readonly _kernelChanged: Signal<this, Session.ISessionConnection.IKernelChangedArgs>;
    private readonly _terminated: Signal<this, void>;
    private readonly _ioPubMessage: Signal<this, KernelMessage.IIOPubMessage>;
    private readonly _propertyChanged: ISignal<this, 'path' | 'name' | 'type'>;
    private readonly _unhandledMessage: Signal<this, KernelMessage.IMessage>;
    private readonly _anyMessage: Signal<this, Kernel.IAnyMessageArgs>;
    private readonly _disposed: Signal<this, void>;
    private readonly _connectionStatusChanged: Signal<this, Kernel.ConnectionStatus>;
    private readonly exitHandler: IDisposable;
    private readonly signaling: typeof import('@lumino/signaling');
    private _jupyterLabServices?: typeof import('@jupyterlab/services');
    private cellExecutedSuccessfully?: boolean;
    public get atleastOneCellExecutedSuccessfully() {
        return this.cellExecutedSuccessfully === true;
    }
    private get jupyterLabServices() {
        if (!this._jupyterLabServices) {
            // Lazy load jupyter lab for faster extension loading.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this._jupyterLabServices = require('@jupyterlab/services') as typeof import('@jupyterlab/services'); // NOSONAR
        }
        return this._jupyterLabServices;
    }

    // RawSession owns the lifetime of the kernel process and will dispose it
    constructor(public kernelProcess: IKernelProcess, public readonly resource: Resource) {
        this.kernelConnectionMetadata = kernelProcess.kernelConnectionMetadata;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const signaling = (this.signaling = require('@lumino/signaling') as typeof import('@lumino/signaling'));
        this._statusChanged = new signaling.Signal<this, KernelMessage.Status>(this);
        this._propertyChanged = new signaling.Signal<this, 'path' | 'name' | 'type'>(this);
        this._kernelChanged = new signaling.Signal<this, Session.ISessionConnection.IKernelChangedArgs>(this);
        this._ioPubMessage = new signaling.Signal<this, KernelMessage.IIOPubMessage>(this);
        this._terminated = new signaling.Signal<this, void>(this);
        this._anyMessage = new signaling.Signal<this, Kernel.IAnyMessageArgs>(this);
        this._unhandledMessage = new signaling.Signal<this, KernelMessage.IMessage>(this);
        this._connectionStatusChanged = new signaling.Signal<this, Kernel.ConnectionStatus>(this);
        this._disposed = new signaling.Signal<this, void>(this);
        // Unique ID for this session instance
        this._id = uuid();

        // ID for our client JMP connection
        this._clientID = uuid();

        // Connect our kernel and hook up status changes
        this._kernel = createRawKernel(kernelProcess, this._clientID);
        this._kernel.statusChanged.connect(this.onKernelStatus, this);
        this._kernel.iopubMessage.connect(this.onIOPubMessage, this);
        this._kernel.connectionStatusChanged.connect(this.onKernelConnectionStatus, this);
        this._kernel.unhandledMessage.connect(this.onUnhandledMessage, this);
        this._kernel.anyMessage.connect(this.onAnyMessage, this);
        this._kernel.disposed.connect(this.onDisposed, this);
        this.exitHandler = kernelProcess.exited(this.handleUnhandledExitingOfKernelProcess, this);
    }
    public get connectionStatus() {
        return this._kernel.connectionStatus;
    }
    public get connectionStatusChanged(): ISignal<this, Kernel.ConnectionStatus> {
        return this._connectionStatusChanged;
    }
    public get disposed(): ISignal<this, void> {
        return this._disposed;
    }
    isRemoteSession?: boolean | undefined;

    public async dispose() {
        // We want to know who called dispose on us
        const stacktrace = new Error().stack;
        sendKernelTelemetryEvent(this.resource, Telemetry.RawKernelSessionDisposed, undefined, { stacktrace });

        // Now actually dispose ourselves
        this.isDisposing = true;
        if (!this.isDisposed) {
            this.exitHandler.dispose();
            await this._kernel
                .shutdown()
                .catch((ex) => traceWarning(`Failed to shutdown kernel, ${this.kernelConnectionMetadata.id}`, ex));
            this._kernel.dispose();
            await this.kernelProcess.dispose();
        }
        try {
            this._kernel.statusChanged.disconnect(this.onKernelStatus, this);
            this._kernel.iopubMessage.disconnect(this.onIOPubMessage, this);
            this._kernel.connectionStatusChanged.disconnect(this.onKernelConnectionStatus, this);
            this._kernel.unhandledMessage.disconnect(this.onUnhandledMessage, this);
            this._kernel.anyMessage.disconnect(this.onAnyMessage, this);
            this._kernel.disposed.disconnect(this.onDisposed, this);
        } catch {
            //
        }
        this.isDisposed = true;
        this.signaling.Signal.disconnectAll(this);
    }

    // Return the ID, this is session's ID, not clientID for messages
    get id(): string {
        return this._id;
    }

    // Return the current kernel for this session
    get kernel(): Kernel.IKernelConnection {
        return this._kernel;
    }

    get kernelSocketInformation(): KernelSocketInformation {
        return {
            socket: this._kernel.socket,
            options: {
                id: this._kernel.id,
                clientId: this._clientID,
                userName: '',
                model: this._kernel.model
            }
        };
    }

    // Provide status changes for the attached kernel
    get statusChanged(): ISignal<this, KernelMessage.Status> {
        return this._statusChanged;
    }

    // Provide a way to wait for connected status
    public async waitForReady(): Promise<void> {
        traceVerbose(`Waiting for Raw session to be ready, currently ${this.connectionStatus}`);
        // When our kernel connects and gets a status message it triggers the ready promise
        const deferred = createDeferred<'connected'>();
        const handler = (_session: OldRawSession, status: Kernel.ConnectionStatus) => {
            if (status == 'connected') {
                traceVerbose('Raw session connected');
                deferred.resolve(status);
            } else {
                traceVerbose(`Raw session not connected, status: ${status}`);
            }
        };
        this.connectionStatusChanged.connect(handler);
        if (this.connectionStatus === 'connected') {
            traceVerbose('Raw session connected');
            deferred.resolve(this.connectionStatus);
        }

        traceVerbose('Waiting for Raw session to be ready for 30s');
        const result = await raceTimeout(30_000, deferred.promise);
        this.connectionStatusChanged.disconnect(handler);
        traceVerbose(`Waited for Raw session to be ready & got ${result}`);

        if (result !== 'connected') {
            throw new KernelConnectionTimeoutError(this.kernelConnectionMetadata);
        }
    }

    // Shutdown our session and kernel
    public shutdown(): Promise<void> {
        return this.dispose();
    }

    // Not Implemented ISession
    get terminated(): ISignal<this, void> {
        return this._terminated;
    }
    get kernelChanged(): ISignal<this, Session.ISessionConnection.IKernelChangedArgs> {
        return this._kernelChanged;
    }
    get propertyChanged(): ISignal<this, 'path' | 'name' | 'type'> {
        return this._propertyChanged;
    }
    get iopubMessage(): ISignal<this, KernelMessage.IIOPubMessage> {
        return this._ioPubMessage;
    }
    get unhandledMessage(): ISignal<this, KernelMessage.IMessage> {
        return this._unhandledMessage;
    }
    get anyMessage(): ISignal<this, Kernel.IAnyMessageArgs> {
        return this._anyMessage;
    }
    get path(): string {
        throw new Error('Not yet implemented');
    }
    get name(): string {
        return this.kernel.name;
    }
    get type(): string {
        return 'notebook';
    }
    get serverSettings(): ServerConnection.ISettings {
        return this.kernel.serverSettings;
    }
    get model(): Session.IModel {
        return {
            id: this._id,
            name: this._kernel.name,
            path: this.kernelProcess.kernelConnectionMetadata.interpreter?.uri.fsPath || 'kernel_path',
            type: 'notebook',
            kernel: this._kernel.model
        };
    }
    get status(): KernelMessage.Status {
        return this.kernel.status;
    }
    public setPath(_path: string): Promise<void> {
        throw new Error('Not yet implemented');
    }
    public setName(_name: string): Promise<void> {
        throw new Error('Not yet implemented');
    }
    public setType(_type: string): Promise<void> {
        throw new Error('Not yet implemented');
    }
    public changeKernel(_options: Partial<Kernel.IModel>): Promise<Kernel.IKernelConnection> {
        throw new Error('Not yet implemented');
    }

    // Private
    // Send out a message when our kernel changes state
    private onKernelStatus(_sender: Kernel.IKernelConnection, state: KernelMessage.Status) {
        traceInfoIfCI(`RawSession status changed to ${state}`);
        this._statusChanged.emit(state);
    }
    private onIOPubMessage(_sender: Kernel.IKernelConnection, msg: KernelMessage.IIOPubMessage) {
        if (
            !this.cellExecutedSuccessfully &&
            msg.header.msg_type === 'execute_result' &&
            msg.content &&
            (this.jupyterLabServices.KernelMessage.isExecuteResultMsg(msg) ||
                this.jupyterLabServices.KernelMessage.isExecuteInputMsg(msg)) &&
            msg.content.execution_count
        ) {
            this.cellExecutedSuccessfully = true;
        }
        this._ioPubMessage.emit(msg);
    }
    private onAnyMessage(_sender: Kernel.IKernelConnection, msg: Kernel.IAnyMessageArgs) {
        this._anyMessage.emit(msg);
    }
    private onUnhandledMessage(_sender: Kernel.IKernelConnection, msg: KernelMessage.IMessage) {
        this._unhandledMessage.emit(msg);
    }
    private onKernelConnectionStatus(_sender: Kernel.IKernelConnection, state: Kernel.ConnectionStatus) {
        this._connectionStatusChanged.emit(state);
    }
    private onDisposed(_sender: Kernel.IKernelConnection) {
        this._disposed.emit();
    }
    private handleUnhandledExitingOfKernelProcess(e: { exitCode?: number | undefined; reason?: string | undefined }) {
        if (this.isDisposing) {
            return;
        }
        traceError(`Disposing session as kernel process died ExitCode: ${e.exitCode}, Reason: ${e.reason}`);
        // Send telemetry so we know why the kernel process exited,
        // as this affects our kernel startup success
        sendKernelTelemetryEvent(
            this.resource,
            Telemetry.RawKernelSessionKernelProcessExited,
            e.exitCode ? { exitCode: e.exitCode } : undefined,
            {
                exitReason: getTelemetrySafeErrorMessageFromPythonTraceback(e.reason)
            }
        );

        // Just kill the session.
        this.dispose().catch(noop);
    }
}

/*
RawSession class implements a jupyterlab ISession object
This provides enough of the ISession interface so that our direct
ZMQ Kernel connection can pretend to be a jupyterlab Session
*/
export class RawSessionConnection implements INewSessionWithSocket {
    public isDisposed: boolean = false;
    public readonly id: string;
    public readonly path: string;
    public readonly name: string;
    private readonly _kernel: RawKernelConnection;
    public readonly statusChanged = new Signal<this, KernelMessage.Status>(this);
    public readonly kernelChanged = new Signal<this, Session.ISessionConnection.IKernelChangedArgs>(this);
    public readonly terminated = new Signal<this, void>(this);
    public readonly iopubMessage = new Signal<this, KernelMessage.IIOPubMessage>(this);
    public readonly unhandledMessage = new Signal<this, KernelMessage.IMessage>(this);
    public readonly anyMessage = new Signal<this, Kernel.IAnyMessageArgs>(this);
    public readonly disposed = new Signal<this, void>(this);
    public readonly connectionStatusChanged = new Signal<this, Kernel.ConnectionStatus>(this);
    public readonly propertyChanged = new Signal<this, 'path' | 'name' | 'type'>(this);
    private _jupyterLabServices?: typeof import('@jupyterlab/services');
    private cellExecutedSuccessfully?: boolean;
    private _didShutDownOnce = false;
    private _isDisposing?: boolean;
    public get atleastOneCellExecutedSuccessfully() {
        return this.cellExecutedSuccessfully === true;
    }
    private get jupyterLabServices() {
        if (!this._jupyterLabServices) {
            // Lazy load jupyter lab for faster extension loading.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this._jupyterLabServices = require('@jupyterlab/services') as typeof import('@jupyterlab/services'); // NOSONAR
        }
        return this._jupyterLabServices;
    }

    public get connectionStatus() {
        return this._kernel?.connectionStatus || 'disconnected';
    }
    get serverSettings(): ServerConnection.ISettings {
        // We do not expect anyone to use this. Hence return a setting thats now expected to work, but at least compiles.
        const jupyterLab = require('@jupyterlab/services') as typeof import('@jupyterlab/services'); // NOSONAR
        return jupyterLab.ServerConnection.makeSettings({
            wsUrl: 'RAW'
        });
    }
    get model(): Session.IModel {
        return {
            id: this.id,
            name: this.name,
            path: this.path,
            type: 'notebook',
            kernel: {
                id: this._kernel?.id,
                name: this.name
            }
        };
    }
    private isTerminating?: boolean;
    get status(): KernelMessage.Status {
        if (this.isTerminating) {
            return 'terminating';
        }
        return this.kernel?.status ?? 'unknown';
    }

    isRemoteSession?: boolean | undefined;

    // RawSession owns the lifetime of the kernel process and will dispose it
    // Return the current kernel for this session
    get kernel(): Kernel.IKernelConnection | null {
        return this._kernel as Kernel.IKernelConnection | null;
    }

    get kernelSocketInformation(): KernelSocketInformation {
        return {
            socket: this._kernel.socket,
            options: {
                id: this._kernel.id,
                clientId: this._kernel.clientId,
                userName: this._kernel.username,
                model: this._kernel.model
            }
        };
    }

    constructor(
        private readonly resource: Resource,
        kernelLauncher: IKernelLauncher,
        workingDirectory: Uri,
        private readonly kernelConnectionMetadata: LocalKernelConnectionMetadata,
        launchTimeout: number,
        public readonly type: 'notebook' | 'console'
    ) {
        // Unique ID for this session instance
        this.id = uuid();
        this.name = getNameOfKernelConnection(this.kernelConnectionMetadata) || 'python3';
        this.path = this.resource?.fsPath || this.kernelConnectionMetadata.interpreter?.uri.fsPath || 'kernel_path';
        // ID for our client JMP connection
        this._kernel = new RawKernelConnection(
            resource,
            kernelLauncher,
            workingDirectory,
            launchTimeout,
            kernelConnectionMetadata
        );
        this._kernel.statusChanged.connect(this.onKernelStatus, this);
        this._kernel.iopubMessage.connect(this.onIOPubMessage, this);
        this._kernel.connectionStatusChanged.connect(this.onKernelConnectionStatus, this);
        this._kernel.unhandledMessage.connect(this.onUnhandledMessage, this);
        this._kernel.anyMessage.connect(this.onAnyMessage, this);
        this._kernel.disposed.connect(this.onDisposed, this);
    }
    public async startKernel(options: { token: CancellationToken }): Promise<void> {
        await trackKernelResourceInformation(this.resource, { kernelConnection: this.kernelConnectionMetadata });
        await this._kernel.start(options.token);
    }
    public dispose() {
        this._isDisposing = true;
        this.disposeAsync().catch(noop);
    }
    public async disposeAsync() {
        this._isDisposing = true;
        // We want to know who called dispose on us
        const stacktrace = new Error().stack;
        sendKernelTelemetryEvent(this.resource, Telemetry.RawKernelSessionDisposed, undefined, { stacktrace });

        // Now actually dispose ourselves
        await this.shutdown().catch(noop);
        this.isDisposed = true;
        this.terminated.emit();
        this.disposed.emit();
        Signal.disconnectAll(this);
    }
    // Shutdown our session and kernel
    public async shutdown(): Promise<void> {
        if (this._didShutDownOnce) {
            return;
        }
        this._didShutDownOnce = true;
        this.isTerminating = true;
        this.statusChanged.emit('terminating');
        try {
            this._kernel.statusChanged.disconnect(this.onKernelStatus, this);
            this._kernel.iopubMessage.disconnect(this.onIOPubMessage, this);
            this._kernel.connectionStatusChanged.disconnect(this.onKernelConnectionStatus, this);
            this._kernel.unhandledMessage.disconnect(this.onUnhandledMessage, this);
            this._kernel.anyMessage.disconnect(this.onAnyMessage, this);
            this._kernel.disposed.disconnect(this.onDisposed, this);
        } catch {
            //
        }
        await this._kernel
            .shutdown()
            .catch((ex) => traceWarning(`Failed to shutdown kernel, ${this.kernelConnectionMetadata.id}`, ex));
        this._kernel.dispose();
        this.isTerminating = false;
        this.statusChanged.emit('dead');
    }
    private onKernelStatus(_sender: Kernel.IKernelConnection, state: KernelMessage.Status) {
        traceInfoIfCI(`RawSession status changed to ${state}`);
        this.statusChanged.emit(state);
        if (
            (this._kernel.status === 'dead' || this._kernel.status === 'terminating') &&
            !this._isDisposing &&
            !this._didShutDownOnce
        ) {
            // Kernel died, kill the session as well.
            this.dispose();
        }
    }

    public setPath(_path: string): Promise<void> {
        throw new Error('Not yet implemented');
    }
    public setName(_name: string): Promise<void> {
        throw new Error('Not yet implemented');
    }
    public setType(_type: string): Promise<void> {
        throw new Error('Not yet implemented');
    }
    public changeKernel(_options: Partial<Kernel.IModel>): Promise<Kernel.IKernelConnection> {
        throw new Error('Not yet implemented');
    }

    // Private
    // Send out a message when our kernel changes state
    private onIOPubMessage(_sender: Kernel.IKernelConnection, msg: KernelMessage.IIOPubMessage) {
        if (
            !this.cellExecutedSuccessfully &&
            msg.header.msg_type === 'execute_result' &&
            msg.content &&
            (this.jupyterLabServices.KernelMessage.isExecuteResultMsg(msg) ||
                this.jupyterLabServices.KernelMessage.isExecuteInputMsg(msg)) &&
            msg.content.execution_count
        ) {
            this.cellExecutedSuccessfully = true;
        }
        this.iopubMessage.emit(msg);
    }
    private onAnyMessage(_sender: Kernel.IKernelConnection, msg: Kernel.IAnyMessageArgs) {
        this.anyMessage.emit(msg);
    }
    private onUnhandledMessage(_sender: Kernel.IKernelConnection, msg: KernelMessage.IMessage) {
        this.unhandledMessage.emit(msg);
    }
    private onKernelConnectionStatus(_sender: Kernel.IKernelConnection, state: Kernel.ConnectionStatus) {
        this.connectionStatusChanged.emit(state);
    }
    private onDisposed(_sender: Kernel.IKernelConnection) {
        this.disposed.emit();
    }
}
