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
const versoes = new Map();
const clone = value => structuredClone(value);

// Controles usados só pelo teste de navegador para simular outro dispositivo, falta de conexão e
// escritas recusadas pelas regras do Firestore. Nada disso existe no SDK real.
const controle = {
    notificacoesPausadas: false,
    colecoesPendentes: new Set(),
    offline: false,
    falhaProximaTransacao: null,
    regraDeEscrita: null,
    // Trecho de caminho cuja LEITURA (getDocs) deve falhar, para simular uma subcoleção inacessível.
    falhaDeLeitura: null,
    // Trecho de caminho cujas leituras ficam RETIDAS até o teste liberá-las, para simular cargas
    // concorrentes que terminam fora de ordem.
    retencaoDeLeitura: null
};

// Leituras retidas, em ordem de chegada: cada uma espera o teste dizer como termina.
const leiturasRetidas = [];

// Contagem de assinaturas por coleção e último callback registrado: existem só para o teste provar que
// não há churn de listener e que um callback atrasado não escreve na interface.
const assinaturas = new Map();
const ultimoCallbackPorColecao = new Map();
// Callbacks de erro das assinaturas ativas e o último registrado por coleção (mesmo propósito acima).
const callbacksDeErro = new Map();
const ultimoCallbackDeErroPorColecao = new Map();

function contarAssinatura(name, campo) {
    const atual = assinaturas.get(name) || { subscribes: 0, unsubscribes: 0 };
    atual[campo] += 1;
    assinaturas.set(name, atual);
}

function erroFirestore(code, message) {
    return Object.assign(new Error(message), { code, name: 'FirebaseError' });
}

function collectionStore(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
}

function chaveVersao(colecao, id) {
    return `${colecao}/${id}`;
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
    if (controle.notificacoesPausadas) {
        controle.colecoesPendentes.add(name);
        return;
    }
    const snapshot = querySnapshot(name);
    for (const callback of listeners.get(name) || []) callback(snapshot);
}

function aplicarCaminhos(anterior, data) {
    // update() aceita caminhos com ponto ("pedido.cancelamento"), como no SDK real.
    const resultado = clone(anterior);
    for (const [caminho, valor] of Object.entries(data)) {
        const partes = caminho.split('.');
        let alvo = resultado;
        partes.slice(0, -1).forEach(parte => {
            if (!alvo[parte] || typeof alvo[parte] !== 'object') alvo[parte] = {};
            alvo = alvo[parte];
        });
        alvo[partes.at(-1)] = clone(valor);
    }
    return resultado;
}

function gravarDocumento(reference, novo) {
    const store = collectionStore(reference.collection);
    const anterior = store.get(reference.id);
    if (controle.regraDeEscrita && !controle.regraDeEscrita(reference.collection, reference.id, clone(anterior), clone(novo))) {
        throw erroFirestore('permission-denied', 'Missing or insufficient permissions.');
    }
    store.set(reference.id, clone(novo));
    const chave = chaveVersao(reference.collection, reference.id);
    versoes.set(chave, (versoes.get(chave) || 0) + 1);
}

function writeDocument(reference, data, options = {}) {
    const previous = collectionStore(reference.collection).get(reference.id) || {};
    gravarDocumento(reference, options.merge ? { ...previous, ...data } : data);
    notify(reference.collection);
}

globalThis.__firestoreMock = {
    pausarNotificacoes() {
        controle.notificacoesPausadas = true;
    },
    retomarNotificacoes() {
        controle.notificacoesPausadas = false;
        const pendentes = [...controle.colecoesPendentes];
        controle.colecoesPendentes.clear();
        pendentes.forEach(notify);
    },
    definirOffline(valor) {
        controle.offline = Boolean(valor);
    },
    falharProximaTransacao(code) {
        controle.falhaProximaTransacao = code;
    },
    definirRegraDeEscrita(regra) {
        controle.regraDeEscrita = regra;
    },
    escreverDiretamente(colecao, id, dados) {
        // Simula outro dispositivo gravando no servidor, sem passar pela interface desta aba.
        gravarDocumento({ collection: colecao, id }, dados);
        notify(colecao);
    },
    lerDiretamente(colecao, id) {
        const dados = collectionStore(colecao).get(id);
        return dados === undefined ? null : clone(dados);
    },
    falharLeituraDe(trechoDoCaminho) {
        // Toda getDocs cujo caminho contenha este trecho passa a rejeitar. Serve para provar que uma
        // subcoleção ilegível derruba a operação inteira em vez de virar "zero documentos".
        controle.falhaDeLeitura = trechoDoCaminho || null;
    },
    estatisticasDeAssinatura(colecao) {
        return { ...(assinaturas.get(colecao) || { subscribes: 0, unsubscribes: 0 }) };
    },
    dispararCallbackTardioDe(colecao) {
        // Invoca o último callback registrado nesta coleção IGNORANDO o unsubscribe, simulando um
        // callback que já estava enfileirado quando a assinatura foi encerrada. O SDK real não promete
        // que isso nunca aconteça, então a aplicação precisa se proteger sozinha.
        const callback = ultimoCallbackPorColecao.get(colecao);
        if (!callback) return false;
        callback(querySnapshot(colecao));
        return true;
    },
    falharListenerDe(colecao) {
        // Entrega um erro às assinaturas ATIVAS desta coleção. Diferença deliberada em relação ao SDK
        // real: lá o listener termina depois do erro; aqui ele continua registrado, para o teste poder
        // provar que um snapshot válido posterior tira a interface do estado de falha. O caminho real
        // (listener encerrado) é coberto pelo "Tentar novamente", que reassina o pedido.
        const erro = erroFirestore('unavailable', `Listener simulado indisponível em ${colecao}.`);
        const ativos = [...(callbacksDeErro.get(colecao) || [])];
        ativos.forEach(callback => callback(erro));
        return ativos.length;
    },
    dispararErroTardioDe(colecao) {
        // Como dispararCallbackTardioDe, mas para o callback de ERRO: chega depois do unsubscribe.
        const callback = ultimoCallbackDeErroPorColecao.get(colecao);
        if (!callback) return false;
        callback(erroFirestore('unavailable', `Erro tardio simulado em ${colecao}.`));
        return true;
    },
    reterLeiturasDe(trechoDoCaminho) {
        // Toda getDocs cujo caminho contenha o trecho fica pendente até liberarLeituraRetida().
        controle.retencaoDeLeitura = trechoDoCaminho || null;
    },
    quantidadeDeLeiturasRetidas() {
        return leiturasRetidas.length;
    },
    liberarLeituraRetida(resultado = 'atual') {
        // Libera a leitura retida MAIS ANTIGA: 'atual' (dados de agora), 'vazio' (como se a subcoleção
        // estivesse vazia quando foi lida) ou 'falha' (a leitura rejeita).
        const pendente = leiturasRetidas.shift();
        if (!pendente) return false;
        pendente.resolve(resultado);
        return true;
    }
};

export function initializeFirestore() {
    return {};
}

export function persistentLocalCache() {
    return {};
}

export function persistentMultipleTabManager() {
    return {};
}

// Caminhos com vários segmentos (subcoleções, ex.: 'orcamentos', id, 'pagamentos', pagamentoId) viram
// uma única chave de coleção plana, unida por '/'. Continua compatível com o uso de nível único já
// existente: collection(db, 'orcamentos') e doc(db, 'orcamentos', id) não mudam de comportamento.
function caminhoDe(segmentos) {
    return segmentos.join('/');
}

export function collection(_db, ...segmentos) {
    return { kind: 'collection', collection: caminhoDe(segmentos) };
}

export function doc(_db, ...segmentos) {
    const id = segmentos.at(-1);
    const collectionName = caminhoDe(segmentos.slice(0, -1));
    return { kind: 'document', collection: collectionName, id };
}

export async function getDocs(reference) {
    if (controle.falhaDeLeitura && reference.collection.includes(controle.falhaDeLeitura)) {
        throw erroFirestore('unavailable', `Leitura simulada indisponível em ${reference.collection}.`);
    }
    if (controle.retencaoDeLeitura && reference.collection.includes(controle.retencaoDeLeitura)) {
        const resultado = await new Promise(resolve => leiturasRetidas.push({ colecao: reference.collection, resolve }));
        if (resultado === 'falha') throw erroFirestore('unavailable', `Leitura retida falhou em ${reference.collection}.`);
        if (resultado === 'vazio') return { docs: [], empty: true };
    }
    return querySnapshot(reference.collection);
}

export function onSnapshot(reference, onNext, onError) {
    const name = reference.collection;
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(onNext);
    if (onError) {
        if (!callbacksDeErro.has(name)) callbacksDeErro.set(name, new Set());
        callbacksDeErro.get(name).add(onError);
        ultimoCallbackDeErroPorColecao.set(name, onError);
    }
    contarAssinatura(name, 'subscribes');
    ultimoCallbackPorColecao.set(name, onNext);
    onNext(querySnapshot(name));
    return () => {
        contarAssinatura(name, 'unsubscribes');
        listeners.get(name)?.delete(onNext);
        if (onError) callbacksDeErro.get(name)?.delete(onError);
    };
}

export async function setDoc(reference, data, options) {
    writeDocument(reference, data, options);
}

export async function updateDoc(reference, data) {
    const store = collectionStore(reference.collection);
    if (!store.has(reference.id)) throw erroFirestore('not-found', 'No document to update.');
    gravarDocumento(reference, aplicarCaminhos(store.get(reference.id), data));
    notify(reference.collection);
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
        update: (reference, data) => operations.push(() => updateDoc(reference, data)),
        delete: reference => operations.push(() => deleteDoc(reference)),
        commit: async () => operations.forEach(operation => operation())
    };
}

export async function runTransaction(_db, callback) {
    // Concorrência otimista como no SDK: se um documento lido mudou antes do commit, a função é
    // executada de novo (até 5 tentativas). Offline, transações falham em vez de enfileirar.
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
        if (controle.offline || globalThis.navigator?.onLine === false) {
            throw erroFirestore('unavailable', 'Failed to get document because the client is offline.');
        }
        if (controle.falhaProximaTransacao) {
            const code = controle.falhaProximaTransacao;
            controle.falhaProximaTransacao = null;
            throw erroFirestore(code, `Transação simulada falhou com ${code}.`);
        }

        const lidas = new Map();
        const operations = [];
        const transaction = {
            get: async reference => {
                const chave = chaveVersao(reference.collection, reference.id);
                lidas.set(chave, versoes.get(chave) || 0);
                await Promise.resolve();
                return documentSnapshot(reference.id, collectionStore(reference.collection).get(reference.id));
            },
            set: (reference, data, options) => operations.push(() => {
                const previous = collectionStore(reference.collection).get(reference.id) || {};
                gravarDocumento(reference, options?.merge ? { ...previous, ...data } : data);
                return reference.collection;
            }),
            update: (reference, data) => operations.push(() => {
                gravarDocumento(reference, aplicarCaminhos(collectionStore(reference.collection).get(reference.id), data));
                return reference.collection;
            })
        };

        const result = await callback(transaction);
        const houveConflito = [...lidas].some(([chave, versao]) => (versoes.get(chave) || 0) !== versao);
        if (houveConflito) continue;

        const colecoes = new Set(operations.map(operation => operation()));
        colecoes.forEach(notify);
        return result;
    }
    throw erroFirestore('aborted', 'Transaction failed after 5 attempts.');
}
