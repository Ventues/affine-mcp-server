import { io } from "socket.io-client";
const DEFAULT_WS_CLIENT_VERSION = process.env.AFFINE_WS_CLIENT_VERSION || process.env.AFFINE_SERVER_VERSION || '0.26.2';
const WS_CONNECT_TIMEOUT_MS = Number(process.env.AFFINE_WS_CONNECT_TIMEOUT_MS || 10000);
const WS_ACK_TIMEOUT_MS = Number(process.env.AFFINE_WS_ACK_TIMEOUT_MS || 10000);
export function wsUrlFromGraphQLEndpoint(endpoint) {
    return endpoint
        .replace('https://', 'wss://')
        .replace('http://', 'ws://')
        .replace(/\/graphql\/?$/, '');
}
export async function connectWorkspaceSocket(wsUrl, extraHeaders) {
    return new Promise((resolve, reject) => {
        const socketOptions = {
            transports: ['websocket'],
            path: '/socket.io/',
            autoConnect: true
        };
        // Add auth token if present in headers
        if (extraHeaders?.Authorization) {
            socketOptions.auth = { token: extraHeaders.Authorization.replace('Bearer ', '') };
        }
        // Add extra headers if present
        if (extraHeaders && Object.keys(extraHeaders).length > 0) {
            socketOptions.extraHeaders = extraHeaders;
        }
        const socket = io(wsUrl, socketOptions);
        const timeout = setTimeout(() => {
            cleanup();
            socket.disconnect();
            reject(new Error(`socket connect timeout after ${WS_CONNECT_TIMEOUT_MS}ms`));
        }, WS_CONNECT_TIMEOUT_MS);
        const onError = (err) => {
            cleanup();
            socket.disconnect();
            reject(err);
        };
        const onConnect = () => {
            cleanup();
            resolve(socket);
        };
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off('connect', onConnect);
            socket.off('connect_error', onError);
        };
        socket.on('connect', onConnect);
        socket.on('connect_error', onError);
    });
}
export async function joinWorkspace(socket, workspaceId, clientVersion = DEFAULT_WS_CLIENT_VERSION) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`space:join timeout after ${WS_ACK_TIMEOUT_MS}ms`));
        }, WS_ACK_TIMEOUT_MS);
        socket.emit('space:join', { spaceType: 'workspace', spaceId: workspaceId, clientVersion }, (ack) => {
            clearTimeout(timeout);
            if (ack?.error)
                return reject(new Error(ack.error.message || 'join failed'));
            if (ack?.data?.success === false)
                return reject(new Error('space:join returned success=false (clientVersion mismatch?)'));
            resolve();
        });
    });
}
export async function loadDoc(socket, workspaceId, docId) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`space:load-doc timeout after ${WS_ACK_TIMEOUT_MS}ms`));
        }, WS_ACK_TIMEOUT_MS);
        socket.emit('space:load-doc', { spaceType: 'workspace', spaceId: workspaceId, docId }, (ack) => {
            clearTimeout(timeout);
            if (ack?.error) {
                if (ack.error.name === 'DOC_NOT_FOUND')
                    return resolve({});
                return reject(new Error(ack.error.message || 'load-doc failed'));
            }
            resolve(ack?.data || {});
        });
    });
}
export async function pushDocUpdate(socket, workspaceId, docId, updateBase64) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`space:push-doc-update timeout after ${WS_ACK_TIMEOUT_MS}ms`));
        }, WS_ACK_TIMEOUT_MS);
        socket.emit('space:push-doc-update', { spaceType: 'workspace', spaceId: workspaceId, docId, update: updateBase64 }, (ack) => {
            clearTimeout(timeout);
            if (ack?.error)
                return reject(new Error(ack.error.message || 'push-doc-update failed'));
            resolve(ack?.data?.timestamp || Date.now());
        });
    });
}
export function deleteDoc(socket, workspaceId, docId) {
    socket.emit('space:delete-doc', { spaceType: 'workspace', spaceId: workspaceId, docId });
}
