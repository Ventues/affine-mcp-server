import { io } from "socket.io-client";
export function wsUrlFromGraphQLEndpoint(endpoint) {
    return endpoint
        .replace('https://', 'wss://')
        .replace('http://', 'ws://')
        .replace(/\/graphql\/?$/, '');
}
export async function connectWorkspaceSocket(wsUrl, cookie) {
    return new Promise((resolve, reject) => {
        const socket = io(wsUrl, {
            transports: ['websocket'],
            path: '/socket.io/',
            extraHeaders: cookie ? { Cookie: cookie } : undefined,
            autoConnect: true
        });
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const onConnect = () => {
            socket.off('connect_error', onError);
            resolve(socket);
        };
        const cleanup = () => {
            socket.off('connect', onConnect);
            socket.off('connect_error', onError);
        };
        socket.on('connect', onConnect);
        socket.on('connect_error', onError);
    });
}
export async function joinWorkspace(socket, workspaceId) {
    return new Promise((resolve, reject) => {
        socket.emit('space:join', { spaceType: 'workspace', spaceId: workspaceId, clientVersion: 'mcp' }, (ack) => {
            if (ack?.error)
                return reject(new Error(ack.error.message || 'join failed'));
            resolve();
        });
    });
}
export async function loadDoc(socket, workspaceId, docId) {
    return new Promise((resolve, reject) => {
        socket.emit('space:load-doc', { spaceType: 'workspace', spaceId: workspaceId, docId }, (ack) => {
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
        socket.emit('space:push-doc-update', { spaceType: 'workspace', spaceId: workspaceId, docId, update: updateBase64 }, (ack) => {
            if (ack?.error)
                return reject(new Error(ack.error.message || 'push-doc-update failed'));
            resolve(ack?.data?.timestamp || Date.now());
        });
    });
}
export function deleteDoc(socket, workspaceId, docId) {
    socket.emit('space:delete-doc', { spaceType: 'workspace', spaceId: workspaceId, docId });
}
