const auth = {
    currentUser: null,
    listeners: new Set()
};

export function getAuth() {
    return auth;
}

export function onAuthStateChanged(authInstance, callback) {
    authInstance.listeners.add(callback);
    queueMicrotask(() => callback(authInstance.currentUser));
    return () => authInstance.listeners.delete(callback);
}

export async function signInWithEmailAndPassword(authInstance, email, password) {
    if (email !== 'teste@example.com' || password !== 'senha-valida') {
        const error = new Error('Credenciais inválidas');
        error.code = 'auth/invalid-credential';
        throw error;
    }

    authInstance.currentUser = { uid: 'usuario-teste' };
    for (const callback of authInstance.listeners) {
        await callback(authInstance.currentUser);
    }
    return { user: authInstance.currentUser };
}

export async function signOut(authInstance) {
    authInstance.currentUser = null;
    for (const callback of authInstance.listeners) {
        await callback(null);
    }
}
