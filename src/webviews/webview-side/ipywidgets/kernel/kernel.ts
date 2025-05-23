// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Kernel, KernelMessage, ServerConnection } from '@jupyterlab/services';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { KernelConnection } from '@jupyterlab/services/lib/kernel/default';
import type { ISignal, Signal } from '@lumino/signaling';
import type * as WebSocketWS from 'ws';
import { KernelSocketOptions } from '../../../../kernels/types';
import { Deferred, createDeferred } from '../../../../platform/common/utils/async';
import { serializeDataViews, deserializeDataViews } from '../../../../platform/common/utils/serializers';
import { IInteractiveWindowMapping, IPyWidgetMessages } from '../../../../messageTypes';
import { IMessageHandler, PostOffice } from '../../react-common/postOffice';
import { noop } from '../../../../platform/common/utils/misc';

/* eslint-disable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
// Proxy kernel that wraps the default kernel. We need this entire class because
// we can't derive from DefaultKernel.
class ProxyKernel implements IMessageHandler, Kernel.IKernelConnection {
    private readonly _ioPubMessageSignal: Signal<this, KernelMessage.IIOPubMessage>;
    public get iopubMessage(): ISignal<this, KernelMessage.IIOPubMessage> {
        return this._ioPubMessageSignal;
    }
    public get statusChanged() {
        return this.realKernel.statusChanged as any;
    }
    public get connectionStatusChanged() {
        return this.realKernel.connectionStatusChanged as any;
    }
    public get unhandledMessage() {
        return this.realKernel.unhandledMessage as any;
    }
    public get anyMessage() {
        return this.realKernel.anyMessage as any;
    }
    public get serverSettings(): ServerConnection.ISettings {
        return this.realKernel.serverSettings;
    }
    public get id(): string {
        return this.realKernel.id;
    }
    public get name(): string {
        return this.realKernel.name;
    }
    public get model(): Kernel.IModel {
        return this.realKernel.model;
    }
    public get username(): string {
        return this.realKernel.username;
    }
    public get clientId(): string {
        return this.realKernel.clientId;
    }
    public get status(): Kernel.Status {
        return this.realKernel.status;
    }
    public get handleComms(): boolean {
        return this.realKernel.handleComms;
    }
    public get isDisposed(): boolean {
        return this.realKernel.isDisposed;
    }
    public get connectionStatus() {
        return this.realKernel.connectionStatus;
    }
    public get spec() {
        return this.realKernel.spec;
    }
    public get info() {
        return this.realKernel.info;
    }
    public get hasComm() {
        return this.realKernel.hasComm;
    }
    public createComm(targetName: string, commId?: string | undefined) {
        return this.realKernel.createComm(targetName, commId);
    }
    public removeInputGuard() {
        return this.realKernel.removeInputGuard();
    }
    public get hasPendingInput() {
        return this.realKernel.hasPendingInput;
    }
    public get disposed() {
        return this.realKernel.disposed as any; // NOSONAR
    }
    public get pendingInput() {
        return this.realKernel.pendingInput as any; // NOSONAR
    }
    public clone(options?: Pick<Kernel.IKernelConnection.IOptions, 'clientId' | 'username' | 'handleComms'>) {
        return new ProxyKernel(
            {
                ...this._options,
                clientId: options?.clientId || this._options.clientId,
                userName: options?.username || this._options.userName
            },
            this.postOffice
        );
    }
    private realKernel: Kernel.IKernelConnection;
    private hookResults = new Map<string, boolean | PromiseLike<boolean>>();
    private websocket: WebSocketWS & { sendEnabled: boolean };
    private messageHook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>;
    private readonly messageHooks = new Map<
        string,
        {
            current: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>;
            previous: ((msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>)[];
        }
    >();
    private readonly lastHookedMessageId: string[] = [];
    private _options: KernelSocketOptions;
    // Messages that are awaiting extension messages to be fully handled
    private awaitingExtensionMessage: Map<string, Deferred<void>>;
    constructor(
        options: KernelSocketOptions,
        private postOffice: PostOffice
    ) {
        // Dummy websocket we give to the underlying real kernel
        let proxySocketInstance: any;
        const protocol = options.protocol;
        class ProxyWebSocket {
            public onopen?: ((this: ProxyWebSocket) => any) | null;
            public onmessage?: ((this: ProxyWebSocket, ev: MessageEvent) => any) | null;
            public sendEnabled: boolean = true;
            public readonly protocol: string = protocol;
            constructor() {
                proxySocketInstance = this;
            }
            public close(_code?: number | undefined, _reason?: string | undefined): void {
                // Nothing.
            }
            public send(data: string | ArrayBuffer | SharedArrayBuffer | Blob | ArrayBufferView): void {
                // This is a command being sent from the UI kernel to the websocket. We mirror that to
                // the extension side.
                if (this.sendEnabled) {
                    if (typeof data === 'string') {
                        postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_msg, data);
                    } else {
                        // Serialize binary data properly before sending to extension.
                        postOffice.sendMessage<IInteractiveWindowMapping>(
                            IPyWidgetMessages.IPyWidgets_binary_msg,
                            serializeDataViews([data as any])
                        );
                    }
                }
            }
        }
        const settings = ServerConnection.makeSettings({ WebSocket: ProxyWebSocket as any, wsUrl: 'BOGUS_PVSC' });

        this.awaitingExtensionMessage = new Map<string, Deferred<void>>();

        // This is crucial, the clientId must match the real kernel in extension.
        // All messages contain the clientId as `session` in the request.
        // If this doesn't match the actual value, then things can and will go wrong.
        this.realKernel = new KernelConnection({
            serverSettings: settings,
            clientId: options.clientId,
            handleComms: true,
            username: options.userName,
            model: options.model
        });

        // Hook up to watch iopub messages from the real kernel
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const signaling = require('@lumino/signaling') as typeof import('@lumino/signaling');
        this._ioPubMessageSignal = new signaling.Signal<this, KernelMessage.IIOPubMessage>(this);
        this.realKernel.iopubMessage.connect(this.onIOPubMessage, this);
        this.realKernel.pendingInput.connect(this.onPendingInput, this);
        this._options = options;

        postOffice.addHandler(this);
        this.websocket = proxySocketInstance;
        this.messageHook = this.messageHookInterceptor.bind(this);
        this.fakeOpenSocket();
    }

    public shutdown(): Promise<void> {
        return this.realKernel.shutdown();
    }
    public sendShellMessage<T extends KernelMessage.ShellMessageType>(
        msg: KernelMessage.IShellMessage<T>,
        expectReply?: boolean,
        disposeOnDone?: boolean
    ): Kernel.IShellFuture<
        KernelMessage.IShellMessage<T>,
        KernelMessage.IShellMessage<KernelMessage.ShellMessageType>
    > {
        return this.realKernel.sendShellMessage(msg, expectReply, disposeOnDone);
    }
    public sendControlMessage<T extends KernelMessage.ControlMessageType>(
        msg: KernelMessage.IControlMessage<T>,
        expectReply?: boolean,
        disposeOnDone?: boolean
    ): Kernel.IControlFuture<
        KernelMessage.IControlMessage<T>,
        KernelMessage.IControlMessage<KernelMessage.ControlMessageType>
    > {
        return this.realKernel.sendControlMessage(msg, expectReply, disposeOnDone);
    }
    public reconnect(): Promise<void> {
        return this.realKernel.reconnect();
    }
    public interrupt(): Promise<void> {
        return this.realKernel.interrupt();
    }
    public restart(): Promise<void> {
        return this.realKernel.restart();
    }
    public requestKernelInfo() {
        return this.realKernel.requestKernelInfo();
    }
    public requestComplete(content: { code: string; cursor_pos: number }): Promise<KernelMessage.ICompleteReplyMsg> {
        return this.realKernel.requestComplete(content);
    }
    public requestInspect(content: {
        code: string;
        cursor_pos: number;
        detail_level: 0 | 1;
    }): Promise<KernelMessage.IInspectReplyMsg> {
        return this.realKernel.requestInspect(content);
    }
    public requestHistory(
        content:
            | KernelMessage.IHistoryRequestRange
            | KernelMessage.IHistoryRequestSearch
            | KernelMessage.IHistoryRequestTail
    ): Promise<KernelMessage.IHistoryReplyMsg> {
        return this.realKernel.requestHistory(content);
    }
    public requestExecute(
        content: {
            code: string;
            silent?: boolean;
            store_history?: boolean;
            user_expressions?: import('@lumino/coreutils').JSONObject;
            allow_stdin?: boolean;
            stop_on_error?: boolean;
        },
        disposeOnDone?: boolean,
        metadata?: import('@lumino/coreutils').JSONObject
    ): Kernel.IShellFuture<KernelMessage.IExecuteRequestMsg, KernelMessage.IExecuteReplyMsg> {
        return this.realKernel.requestExecute(content, disposeOnDone, metadata);
    }
    public requestDebug(
        // eslint-disable-next-line no-caller,no-eval
        content: { seq: number; type: 'request'; command: string; arguments?: any },
        disposeOnDone?: boolean
    ): Kernel.IControlFuture<KernelMessage.IDebugRequestMsg, KernelMessage.IDebugReplyMsg> {
        return this.realKernel.requestDebug(content, disposeOnDone);
    }
    public requestIsComplete(content: { code: string }): Promise<KernelMessage.IIsCompleteReplyMsg> {
        return this.realKernel.requestIsComplete(content);
    }
    public requestCommInfo(content: {
        target_name?: string;
        target?: string;
    }): Promise<KernelMessage.ICommInfoReplyMsg> {
        return this.realKernel.requestCommInfo(content);
    }
    public sendInputReply(
        content: KernelMessage.IInputReplyMsg['content'],
        parent_header: KernelMessage.IInputReplyMsg['parent_header']
    ): void {
        return this.realKernel.sendInputReply(content, parent_header);
    }
    public registerCommTarget(
        targetName: string,
        callback: (comm: Kernel.IComm, msg: KernelMessage.ICommOpenMsg) => void | PromiseLike<void>
    ): void {
        // When a comm target has been registered, we need to register this in the real kernel in extension side.
        // Hence send that message to extension.
        this.postOffice.sendMessage<IInteractiveWindowMapping>(
            IPyWidgetMessages.IPyWidgets_registerCommTarget,
            targetName
        );
        return this.realKernel.registerCommTarget(targetName, callback);
    }
    public removeCommTarget(
        targetName: string,
        callback: (comm: Kernel.IComm, msg: KernelMessage.ICommOpenMsg) => void | PromiseLike<void>
    ): void {
        return this.realKernel.removeCommTarget(targetName, callback);
    }
    public dispose(): void {
        this.postOffice.removeHandler(this);
        return this.realKernel.dispose();
    }
    public handleMessage(type: string, payload?: any): boolean {
        // Handle messages as they come in. Note: Do not await anything here. THey have to be inorder.
        // If not, we could switch to message chaining or an observable instead.
        switch (type) {
            case IPyWidgetMessages.IPyWidgets_MessageHookCall:
                this.sendHookResult(payload);
                break;

            case IPyWidgetMessages.IPyWidgets_msg:
                if (this.websocket && this.websocket.onmessage) {
                    this.websocket.onmessage({ target: this.websocket, data: payload.data, type: '' });
                }
                this.sendResponse(payload.id);
                break;

            case IPyWidgetMessages.IPyWidgets_binary_msg:
                if (this.websocket && this.websocket.onmessage) {
                    const deserialized = deserializeDataViews(payload.data)![0];
                    this.websocket.onmessage({ target: this.websocket, data: deserialized as any, type: '' });
                }
                this.sendResponse(payload.id);
                break;

            case IPyWidgetMessages.IPyWidgets_mirror_execute:
                this.handleMirrorExecute(payload);
                break;

            case IPyWidgetMessages.IPyWidgets_ExtensionOperationHandled:
                this.extensionOperationFinished(payload);
                break;

            case IPyWidgetMessages.IPyWidgets_registerCommTarget:
                this.realKernel.registerCommTarget(payload, noop);
                break;

            default:
                break;
        }
        return true;
    }
    public registerMessageHook(
        msgId: string,
        hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>
    ): void {
        // We don't want to finish our processing of this message until the extension has told us that it has finished
        // With the extension side registering of the message hook
        const waitPromise = createDeferred<void>();

        // A message could cause multiple callback waits, so use id+type as key
        const key = this.generateExtensionResponseKey(
            msgId,
            IPyWidgetMessages.IPyWidgets_RegisterMessageHook.toString()
        );
        this.awaitingExtensionMessage.set(key, waitPromise);

        // Tell the other side about this.
        this.postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_RegisterMessageHook, msgId);

        // Save the real hook so we can call it
        const item = this.messageHooks.get(msgId);
        if (item) {
            // Preserve the previous hook and setup a new hook for the same comm msg.
            item.previous.push(item.current);
            item.current = hook;
        } else {
            this.messageHooks.set(msgId, { current: hook, previous: [] });
        }

        // Wrap the hook and send it to the real kernel
        this.realKernel.registerMessageHook(msgId, this.messageHook);
    }

    public removeMessageHook(
        msgId: string,
        _hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>
    ): void {
        // We don't want to finish our processing of this message until the extension has told us that it has finished
        // With the extension side removing of the message hook
        const waitPromise = createDeferred<void>();

        // A message could cause multiple callback waits, so use id+type as key
        const key = this.generateExtensionResponseKey(msgId, IPyWidgetMessages.IPyWidgets_RemoveMessageHook.toString());
        this.awaitingExtensionMessage.set(key, waitPromise);

        this.postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_RemoveMessageHook, {
            hookMsgId: msgId,
            lastHookedMsgId: this.lastHookedMessageId.length ? this.lastHookedMessageId.pop() : undefined
        });

        // Remove our mapping
        const item = this.messageHooks.get(msgId);
        if (item) {
            if (item.previous.length > 0) {
                item.current = item.previous.pop()!;
            } else {
                this.messageHooks.delete(msgId);
                // Remove from the real kernel
                this.realKernel.removeMessageHook(msgId, this.messageHook);
            }
        }
    }

    // Called when the extension has finished an operation that we are waiting for in message processing
    private extensionOperationFinished(payload: any) {
        //const key = payload.id + payload.type;
        const key = `${payload.id}${payload.type}`;

        const waitPromise = this.awaitingExtensionMessage.get(key);

        if (waitPromise) {
            waitPromise.resolve();
            this.awaitingExtensionMessage.delete(key);
        }
    }

    private sendResponse(id: string) {
        this.postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_msg_received, {
            id
        });
    }

    private generateExtensionResponseKey(msgId: string, msgType: string): string {
        return `${msgId}${msgType}`;
    }

    private fakeOpenSocket() {
        // This is kind of the hand shake.
        // As soon as websocket opens up, the kernel sends a request to check if it is alive.
        // If it gets a response, then it is deemed ready.
        const originalRequestKernelInfo = this.realKernel.requestKernelInfo.bind(this.realKernel);
        this.realKernel.requestKernelInfo = () => {
            this.realKernel.requestKernelInfo = originalRequestKernelInfo;
            return Promise.resolve() as any;
        };
        if (this.websocket) {
            this.websocket.onopen({ target: this.websocket });
        }
        this.realKernel.requestKernelInfo = originalRequestKernelInfo;
    }
    private messageHookInterceptor(msg: KernelMessage.IIOPubMessage): boolean | PromiseLike<boolean> {
        try {
            // Save the active message that is currently being hooked. The Extension
            // side needs this information during removeMessageHook so it can delay removal until after a message is called
            this.lastHookedMessageId.push(msg.header.msg_id);

            const hook = this.messageHooks.get((msg.parent_header as any).msg_id);
            if (hook) {
                // When the kernel calls the hook, save the result for this message. The other side will ask for it
                const result = hook.current(msg);
                this.hookResults.set(msg.header.msg_id, result);
                if ((result as any).then) {
                    return (result as any).then((r: boolean) => {
                        return r;
                    });
                }

                // When not a promise reset right after
                return result;
            }
        } catch (ex) {
            // Swallow exceptions so processing continues
        }
        return false;
    }

    private sendHookResult(args: { requestId: string; parentId: string; msg: KernelMessage.IIOPubMessage }) {
        const result = this.hookResults.get(args.msg.header.msg_id);
        if (result !== undefined) {
            this.hookResults.delete(args.msg.header.msg_id);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((result as any).then) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (result as any).then((r: boolean) => {
                    this.postOffice.sendMessage<IInteractiveWindowMapping>(
                        IPyWidgetMessages.IPyWidgets_MessageHookResult,
                        {
                            requestId: args.requestId,
                            parentId: args.parentId,
                            msgType: args.msg.header.msg_type,
                            result: r
                        }
                    );
                });
            } else {
                this.postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_MessageHookResult, {
                    requestId: args.requestId,
                    parentId: args.parentId,
                    msgType: args.msg.header.msg_type,
                    result: result === true
                });
            }
        } else {
            // If no hook registered, make sure not to remove messages.
            this.postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_MessageHookResult, {
                requestId: args.requestId,
                parentId: args.parentId,
                msgType: args.msg.header.msg_type,
                result: true
            });
        }
    }

    private handleMirrorExecute(payload: { id: string; msg: KernelMessage.IExecuteRequestMsg }) {
        // Special case. This is a mirrored execute. We want this to go to the real kernel, but not send a message
        // back to the websocket. This should cause the appropriate futures to be generated.
        try {
            this.websocket.sendEnabled = false;
            // Make sure we don't dispose on done (that will eliminate the future when it's done)
            this.realKernel.sendShellMessage(payload.msg, false, payload.msg.content.silent);
        } finally {
            this.websocket.sendEnabled = true;
        }
        this.sendResponse(payload.id);
    }

    // When the real kernel handles iopub messages notify the Extension side and then forward on the message
    // Note, this message comes from the kernel after it is done handling the message async
    private onIOPubMessage(_sender: Kernel.IKernelConnection, message: KernelMessage.IIOPubMessage) {
        // If we are not waiting for anything on the extension just send it
        if (this.awaitingExtensionMessage.size <= 0) {
            this.finishIOPubMessage(message);
        } else {
            // If we are waiting for something from the extension, wait for all that to finish before
            // we send the message that we are done handling this message
            // Since the Extension is blocking waiting for this message to be handled we know all extension message are
            // related to this message or before and should be resolved before we move on
            const extensionPromises = Array.from(this.awaitingExtensionMessage.values()).map((value) => {
                return value.promise;
            });
            Promise.all(extensionPromises)
                .then(() => {
                    // Fine to wait and send this in the catch as the Extension is blocking new messages for this and the UI kernel
                    // has already finished handling it
                    this.finishIOPubMessage(message);
                })
                .catch((ex) => {
                    window.console.error('Failed to send iopub_msg_handled message', ex);
                });
        }
    }

    private onPendingInput(_sender: Kernel.IKernelConnection, message: boolean) {
        this.pendingInput.emit(message);
    }

    // Finish an iopub message by sending a message to the UI and then emitting that we are done with it
    private finishIOPubMessage(message: KernelMessage.IIOPubMessage) {
        this.postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_iopub_msg_handled, {
            id: message.header.msg_id
        });
        this._ioPubMessageSignal.emit(message);
    }
}

/**
 * Creates a kernel from a websocket.
 * Check code in `node_modules/@jupyterlab/services/lib/kernel/default.js`.
 * The `_createSocket` method basically connects to a websocket and listens to messages.
 * Hence to create a kernel, all we need is a socket connection (class with onMessage and postMessage methods).
 */
export function create(
    options: KernelSocketOptions,
    postOffice: PostOffice,
    pendingMessages: { message: string; payload: any }[]
): Kernel.IKernelConnection {
    const result = new ProxyKernel(options, postOffice);
    // Make sure to handle all the missed messages
    pendingMessages.forEach((m) => result.handleMessage(m.message, m.payload));
    return result;
}
