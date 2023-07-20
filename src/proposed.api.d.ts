// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Uri } from 'vscode';

/**
 * Provides information required to connect to a Jupyter Server.
 */
export interface JupyterServerConnectionInformation {
    /**
     * Base Url of the Jupyter Server
     */
    readonly baseUrl: Uri;
    /**
     * Jupyter auth Token
     */
    readonly token: string;
    /**
     * Authorization header to be used when connecting to the server.
     */
    readonly authorizationHeader?: Record<string, string>;
    /**
     * The local directory that maps to the remote directory of the Jupyter Server.
     * E.g. assume you start Jupyter Notebook with --notebook-dir=/foo/bar,
     * and you have a file named /foo/bar/sample.ipynb, /foo/bar/sample2.ipynb and the like.
     * Then assume the mapped local directory will be /users/xyz/remoteServer and the files sample.ipynb and sample2.ipynb
     * are in the above local directory.
     *
     * Using this setting one can map the local directory to the remote directory.
     * In this case the value of this property would be /users/xyz/remoteServer.
     *
     * Note: A side effect of providing this value is the session names are generated the way they are in Jupyter Notebook/Lab.
     * I.e. the session names map to the relative path of the notebook file.
     * As a result when attempting to create a new session for a notebook/file, Jupyter will
     * first check if a session already exists for the same file and same kernel, and if so, will re-use that session.
     */
    readonly mappedRemoteNotebookDir?: Uri;
    /**
     * Returns the sub-protocols to be used. See details of `protocols` here https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket
     * Useful if there is a custom authentication scheme that needs to be used for WebSocket connections.
     * Note: The client side npm package @jupyterlab/services uses WebSockets to connect to remote Kernels.
     */
    readonly webSocketProtocols?: string[];
}

/**
 * Represents a Jupyter Server displayed in the list of Servers.
 */
export interface JupyterServer {
    /**
     * Unique identifier for this server.
     */
    readonly id: string;
    /**
     * A human-readable string which is rendered prominent.
     */
    label: string;
    /**
     * Returns the connection information for this server.
     */
    resolveConnectionInformation: () => Promise<JupyterServerConnectionInformation>;
    /**
     * Removes this from the list of Servers.
     */
    dispose(): void;
}

/**
 * Creates an entry in the list of servers that the user can pick from to create/select a Jupyter Server.
 * Selecting this item results in eventually creating a Jupyter Server.
 */
export interface JupyterServerCreationItem {
    /**
     * A human-readable string which is rendered prominent. Supports rendering of {@link ThemeIcon theme icons} via
     * the `$(<name>)`-syntax.
     */
    label: string;
    /**
     * A human-readable string which is rendered less prominent in a separate line. Supports rendering of
     * {@link ThemeIcon theme icons} via the `$(<name>)`-syntax.
     */
    detail?: string;
    /**
     * A string that should be used when comparing this item
     * with other items. When `falsy` the {@link JupyterServerCreationItem label}
     * is used.
     */
    sortText?: string;
    /**
     * Optional flag indicating if this item is picked by default.
     * If there are no existing servers, and this flag is true, then this item will be picked by default.
     *
     * Note: this property is ignored when {@link JupyterServerCollection.createServer createJupyterServer} has been called.
     */
    picked?: boolean;
    /**
     * Called by Jupyter Extension when this item is selected, and the extension is expected to create a Jupyter Server.
     */
    onDidSelect: () => Promise<JupyterServer | undefined>;
    /**
     * Removes this entry from the list.
     */
    dispose(): void;
}

/**
 * Creates an entry in the Kernel Picker for Jupyter Servers.
 */
export interface JupyterServerCollection {
    /**
     * Identifier must be globally unique.
     */
    readonly id: string;
    /**
     * A human-readable string which is rendered prominent.
     */
    label: string;
    /**
     * A link to a page providing more information to the user about this item.
     */
    documentation?: Uri;
    /**
     * Creates an entry in the list of Jupyter Servers from which the user can pick.
     *
     * @param id
     * @param label
     * @param resolveConnectionInformation Gets the connection information for the Jupyter Server.
     */
    createServer(
        id: string,
        label: string,
        resolveConnectionInformation: () => Promise<JupyterServerConnectionInformation>
    ): JupyterServer;
    /**
     * Creates an entry in the list of Jupyter Servers from which a user can pick to create a server.
     * Picking an item is expected to result in the eventual creation of a JupyterServer.
     * I.e. an extension is expected to listen to the `onDidSelect` event and optionally display their own UI and then create a JupyterServer.
     *
     * @param label
     * @param onDidSelect Callback invoked when this item is selected.
     */
    createServerCreationItem(
        label: string,
        onDidSelect: () => Promise<JupyterServer | undefined>
    ): JupyterServerCreationItem;
    /**
     * Removes this item from the Kernel Picker.
     */
    dispose(): void;
}

/**
 * Sample usage extensions.getExtension<JupyterAPI>('ms-ai-tools.jupyter')?.exports;
 */
export interface JupyterAPI {
    /**
     * Provides the ability to register multiple collections of Jupyter Servers.
     *
     * @param id Identifier must be globally unique.
     * @param label
     */
    createServerCollection(id: string, label: string): Promise<JupyterServerCollection>;
}
