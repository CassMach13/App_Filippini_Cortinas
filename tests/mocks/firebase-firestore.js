const produtoTeste = {
    codigo: 'TEST-UNIT',
    descricao: 'Produto válido para teste de navegador',
    fornecedor: 'Fornecedor Teste',
    categoria: 'Acessórios',
    unidadeMedida: 'Unidade',
    precoCompra: 100,
    markup: 2,
    cor: 'Branco',
    status: 'Ativo'
};

const produtosAcabados = Array.from({ length: 10 }, (_, indice) => {
    const numero = indice + 1;
    const ambiente = `Ambiente ${numero}`;
    return {
        id: `produto-${numero}`,
        nome: `Cortina Teste ${numero}`,
        ambiente,
        observacoes: `Instruções do ambiente ${numero}`,
        observacoesCliente: `Observação do ambiente ${numero}`,
        itens: [{
            id: `item-${numero}`,
            ambiente,
            categoria: produtoTeste.categoria,
            codigo: produtoTeste.codigo,
            descricao: produtoTeste.descricao,
            cor: produtoTeste.cor,
            fornecedor: produtoTeste.fornecedor,
            quantidade: 1,
            largura: null,
            altura: null,
            unidadeMedida: produtoTeste.unidadeMedida,
            precoUnitario: 200,
            precoTotal: 200,
            custoReal: 100,
            quantidadeCompra: 1,
            precoCompraUnitario: 100,
            margemLiquida: 100,
            margemPercentual: 50,
            valorComissao: 0,
            observacoes: ''
        }]
    };
});

const orcamentoInicial = {
    id: 'ORC-01',
    statusDocumento: 'orcamento',
    apresentacao: {
        modo: 'reduzida',
        mostrarValoresItens: false,
        mostrarCustosFornecedor: false
    },
    infoGerais: {
        nome: 'Orçamento ORC-01',
        nomeCliente: 'Cliente de Teste',
        enderecoCliente: 'Endereço de Teste',
        tipoCliente: 'cliente',
        dataOrcamento: '2025-01-01',
        prazoValidade: '2025-01-15',
        prazoEntrega: '30 dias úteis',
        dataInstalacao: '2025-02-01',
        nomeCostureira: '',
        enderecoCostureira: '',
        nomeInstalador: '',
        observacoesGerais: ''
    },
    infoComercial: {
        condicaoPagamento: 'À vista',
        formaPagamento: 'PIX',
        descontoGlobal: 0,
        observacoesComerciais: ''
    },
    itens: [],
    produtosAcabados,
    valoresInstalacao: {}
};

const collections = new Map([
    ['precos', new Map([['produto-teste', produtoTeste]])],
    ['fornecedores', new Map([['fornecedor-teste', { nome: 'Fornecedor Teste', status: 'Ativo' }]])],
    ['categorias', new Map([['categoria-teste', { nome: 'Acessórios', status: 'Ativo' }]])],
    ['unidadesDeMedida', new Map([['unidade-teste', { nome: 'Unidade', status: 'Ativo' }]])],
    ['orcamentos', new Map([['ORC-01', orcamentoInicial]])],
    ['contadores', new Map([['orcamentos', { ultimoNumero: 1 }]])]
]);

const listeners = new Map();
const clone = value => structuredClone(value);

function collectionStore(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
}

function documentSnapshot(id, data) {
    return {
        id,
        metadata: { hasPendingWrites: false },
        exists: () => data !== undefined,
        data: () => clone(data)
    };
}

function querySnapshot(name) {
    const docs = [...collectionStore(name).entries()]
        .map(([id, data]) => documentSnapshot(id, data));
    return { docs, empty: docs.length === 0 };
}

function notify(name) {
    const snapshot = querySnapshot(name);
    for (const callback of listeners.get(name) || []) callback(snapshot);
}

function writeDocument(reference, data, options = {}) {
    const store = collectionStore(reference.collection);
    const previous = store.get(reference.id) || {};
    store.set(reference.id, clone(options.merge ? { ...previous, ...data } : data));
    notify(reference.collection);
}

export function initializeFirestore() {
    return {};
}

export function persistentLocalCache() {
    return {};
}

export function persistentMultipleTabManager() {
    return {};
}

export function collection(_db, name) {
    return { kind: 'collection', collection: name };
}

export function doc(_db, collectionName, id) {
    return { kind: 'document', collection: collectionName, id };
}

export async function getDocs(reference) {
    return querySnapshot(reference.collection);
}

export function onSnapshot(reference, onNext) {
    const name = reference.collection;
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(onNext);
    onNext(querySnapshot(name));
    return () => listeners.get(name)?.delete(onNext);
}

export async function setDoc(reference, data, options) {
    writeDocument(reference, data, options);
}

export async function updateDoc(reference, data) {
    writeDocument(reference, data, { merge: true });
}

export async function deleteDoc(reference) {
    collectionStore(reference.collection).delete(reference.id);
    notify(reference.collection);
}

export async function addDoc(reference, data) {
    const id = `mock-${crypto.randomUUID()}`;
    writeDocument({ collection: reference.collection, id }, data);
    return { id };
}

export function query(reference) {
    return reference;
}

export function where() {
    return {};
}

export function writeBatch() {
    const operations = [];
    return {
        set: (reference, data, options) => operations.push(() => writeDocument(reference, data, options)),
        update: (reference, data) => operations.push(() => writeDocument(reference, data, { merge: true })),
        delete: reference => operations.push(() => deleteDoc(reference)),
        commit: async () => operations.forEach(operation => operation())
    };
}

export async function runTransaction(_db, callback) {
    const operations = [];
    const transaction = {
        get: async reference => documentSnapshot(
            reference.id,
            collectionStore(reference.collection).get(reference.id)
        ),
        set: (reference, data, options) => operations.push(() => writeDocument(reference, data, options)),
        update: (reference, data) => operations.push(() => writeDocument(reference, data, { merge: true }))
    };
    const result = await callback(transaction);
    operations.forEach(operation => operation());
    return result;
}
