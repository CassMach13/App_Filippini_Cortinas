// Restauração administrativa de um backup v2 completo, inclusive pagamentos e auditoria (Etapa 4B2R).
//
// Uso:
//   node scripts/restaurar-backup.mjs <backup.json> --project <projeto>            (dry-run, zero writes)
//   node scripts/restaurar-backup.mjs <backup.json> --project <projeto> --apply    (grava)
//
// Roda na máquina do administrador com o Firebase Admin SDK e Application Default Credentials
// (`gcloud auth application-default login`). Nenhuma chave JSON é criada ou lida pelo repositório.
// O Admin SDK ignora as Firestore Rules: por isso esta ferramenta só CRIA documentos ausentes e nunca
// altera um documento existente. Para cada documento do backup:
//   ausente no destino       -> CREATE
//   existe e é igual         -> SKIP
//   existe e é diferente     -> CONFLICT (bloqueia o --apply inteiro)
// Se uma execução parar no meio, rodar de novo é seguro: o que já entrou vira SKIP.
// O contador contadores/orcamentos não é tocado: o app já reserva o próximo número a partir do maior
// ORC carregado.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { obterDataCivilAtual } from '../date-domain.js';
import { valoresIguais } from '../order-domain.js';
import { prepararPagamentosParaBackup } from '../payments-domain.js';

const COLECOES_CATALOGO = ['precos', 'fornecedores', 'categorias', 'unidadesDeMedida'];

export class ErroRestauracao extends Error {
    constructor(mensagem) {
        super(mensagem);
        this.name = 'ErroRestauracao';
    }
}

export function lerArgumentos(argv) {
    const argumentos = { arquivo: null, projeto: null, aplicar: false };
    for (let i = 0; i < argv.length; i++) {
        const atual = argv[i];
        if (atual === '--apply') argumentos.aplicar = true;
        else if (atual === '--project') argumentos.projeto = argv[++i] ?? null;
        else if (atual.startsWith('--')) throw new ErroRestauracao(`Opção desconhecida: ${atual}`);
        else if (argumentos.arquivo === null) argumentos.arquivo = atual;
        else throw new ErroRestauracao(`Argumento inesperado: ${atual}`);
    }
    if (!argumentos.arquivo) throw new ErroRestauracao('Informe o arquivo de backup.');
    // Nunca cair no projeto padrão da Firebase CLI ou do gcloud: o alvo precisa ser explícito.
    if (!argumentos.projeto || argumentos.projeto.startsWith('--')) {
        throw new ErroRestauracao('--project é obrigatório (ex.: --project filippini-cortinas).');
    }
    return argumentos;
}

function ehObjeto(valor) {
    return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

function exigirId(id, contexto) {
    if (typeof id !== 'string' || id.length === 0 || id.includes('/')) {
        throw new ErroRestauracao(`${contexto}: id inválido (${JSON.stringify(id)}).`);
    }
}

// Valida o arquivo inteiro e devolve a lista de documentos a restaurar. Nada aqui acessa o Firestore:
// um backup inválido é recusado antes de qualquer leitura ou escrita no destino.
export function montarDocumentosDoBackup(backup, { hoje = obterDataCivilAtual() } = {}) {
    if (!ehObjeto(backup)) throw new ErroRestauracao('O backup precisa ser um objeto JSON.');
    if (backup.version !== '2.0') throw new ErroRestauracao(`version precisa ser "2.0" (recebido ${JSON.stringify(backup.version)}).`);
    if (backup.versaoBackup !== 2) throw new ErroRestauracao(`versaoBackup precisa ser 2 (recebido ${JSON.stringify(backup.versaoBackup)}).`);
    for (const colecao of COLECOES_CATALOGO) {
        if (!Array.isArray(backup[colecao])) throw new ErroRestauracao(`${colecao} precisa ser um array.`);
    }
    if (!ehObjeto(backup.orcamentosSalvos)) throw new ErroRestauracao('orcamentosSalvos precisa ser um objeto.');
    if (!Array.isArray(backup.pagamentos)) throw new ErroRestauracao('pagamentos precisa ser um array.');

    const documentos = [];
    const caminhosVistos = new Set();
    const adicionar = (caminho, dados, grupo) => {
        if (caminhosVistos.has(caminho)) throw new ErroRestauracao(`Documento duplicado no backup: ${caminho}.`);
        caminhosVistos.add(caminho);
        documentos.push({ caminho, dados, grupo });
    };

    // Catálogos: o app guarda { id: doc.id, ...dados }; o id vira o ID do documento, como na importação
    // do navegador.
    for (const colecao of COLECOES_CATALOGO) {
        backup[colecao].forEach((registro, indice) => {
            if (!ehObjeto(registro)) throw new ErroRestauracao(`${colecao}[${indice}] precisa ser um objeto.`);
            exigirId(registro.id, `${colecao}[${indice}]`);
            const { id, ...dados } = registro;
            adicionar(`${colecao}/${id}`, dados, null);
        });
    }

    // Orçamentos: a chave do mapa é o ID do documento e o próprio documento guarda `id`. `firestoreId`
    // é um artefato que o app acrescenta em memória; sai antes de comparar/gravar. Se ele divergir da
    // chave, o backup não diz com certeza qual é o ID real do documento: recusa.
    const orcamentosLimpos = {};
    for (const [chave, registro] of Object.entries(backup.orcamentosSalvos)) {
        exigirId(chave, `orcamentosSalvos["${chave}"]`);
        if (!ehObjeto(registro)) throw new ErroRestauracao(`orcamentosSalvos["${chave}"] precisa ser um objeto.`);
        if (registro.id !== chave) throw new ErroRestauracao(`orcamentosSalvos["${chave}"]: id interno diferente da chave.`);
        if (registro.firestoreId !== undefined && registro.firestoreId !== chave) {
            throw new ErroRestauracao(`orcamentosSalvos["${chave}"]: firestoreId diferente da chave.`);
        }
        const { firestoreId: _artefato, ...dados } = registro;
        orcamentosLimpos[chave] = dados;
        adicionar(`orcamentos/${chave}`, dados, null);
    }

    // Pagamentos: a mesma certificação da exportação (identidade, pai v2 válido no backup, movimento e
    // cadeia completa de auditoria). Nenhuma regra financeira é refeita aqui.
    let certificados;
    try {
        certificados = prepararPagamentosParaBackup(backup.pagamentos, orcamentosLimpos, { hoje });
    } catch (erro) {
        throw new ErroRestauracao(`Pagamentos inválidos: ${erro.message}`);
    }
    for (const registro of certificados) {
        exigirId(registro.pagamentoId, `pagamento do pedido ${registro.orcamentoId}`);
        const base = `orcamentos/${registro.orcamentoId}/pagamentos/${registro.pagamentoId}`;
        adicionar(base, registro.movimento, base);
        for (const evento of registro.auditoria) {
            adicionar(`${base}/auditoria/${evento.eventoId}`, evento.dados, base);
        }
    }

    return {
        documentos,
        totais: {
            orcamentos: Object.keys(orcamentosLimpos).length,
            pagamentos: certificados.length,
            eventos: certificados.reduce((soma, registro) => soma + registro.auditoria.length, 0)
        }
    };
}

function classificar(snapshot, dados) {
    if (!snapshot.exists) return 'CREATE';
    return valoresIguais(snapshot.data(), dados) ? 'SKIP' : 'CONFLICT';
}

export async function classificarDocumentos(db, documentos) {
    const referencias = documentos.map(({ caminho }) => db.doc(caminho));
    const snapshots = [];
    for (let inicio = 0; inicio < referencias.length; inicio += 300) {
        snapshots.push(...await db.getAll(...referencias.slice(inicio, inicio + 300)));
    }
    return documentos.map((documento, indice) => ({ ...documento, acao: classificar(snapshots[indice], documento.dados) }));
}

// Grava só o que está ausente. Catálogos e orçamentos vêm antes dos pagamentos, para que o pai já exista.
// Cada pagamento (movimento + todos os eventos) é uma transação: relê tudo, e qualquer documento que
// tenha aparecido diferente desde a classificação aborta sem gravar nada daquele pagamento.
export async function aplicarRestauracao(db, classificados) {
    let gravados = 0;
    for (const documento of classificados.filter(item => item.grupo === null && item.acao === 'CREATE')) {
        await db.doc(documento.caminho).create(documento.dados);
        gravados++;
    }

    const grupos = new Map();
    for (const documento of classificados.filter(item => item.grupo !== null)) {
        if (!grupos.has(documento.grupo)) grupos.set(documento.grupo, []);
        grupos.get(documento.grupo).push(documento);
    }
    for (const [grupo, documentosDoGrupo] of grupos) {
        if (documentosDoGrupo.every(item => item.acao === 'SKIP')) continue;
        gravados += await db.runTransaction(async transacao => {
            const referencias = documentosDoGrupo.map(({ caminho }) => db.doc(caminho));
            const snapshots = await transacao.getAll(...referencias);
            let criados = 0;
            documentosDoGrupo.forEach((documento, indice) => {
                const acao = classificar(snapshots[indice], documento.dados);
                if (acao === 'CONFLICT') throw new ErroRestauracao(`Conflito surgiu durante a gravação: ${documento.caminho}. Nada deste pagamento (${grupo}) foi gravado.`);
                if (acao === 'CREATE') {
                    transacao.create(referencias[indice], documento.dados);
                    criados++;
                }
            });
            return criados;
        });
    }
    return gravados;
}

function contar(classificados) {
    return classificados.reduce((contagem, { acao }) => ({ ...contagem, [acao]: contagem[acao] + 1 }), { CREATE: 0, SKIP: 0, CONFLICT: 0 });
}

function imprimirResumo(escrever, projeto, totais, contagem) {
    escrever(`Projeto: ${projeto}${process.env.FIRESTORE_EMULATOR_HOST ? ` (emulador ${process.env.FIRESTORE_EMULATOR_HOST})` : ''}`);
    escrever(`Orçamentos: ${totais.orcamentos}`);
    escrever(`Pagamentos: ${totais.pagamentos}`);
    escrever(`Eventos: ${totais.eventos}`);
    escrever('');
    escrever(`CREATE: ${contagem.CREATE}`);
    escrever(`SKIP: ${contagem.SKIP}`);
    escrever(`CONFLICT: ${contagem.CONFLICT}`);
}

// Devolve o código de saída: 0 sucesso, 1 erro de uso/validação/gravação, 2 conflito.
export async function executar(argv, { escrever = console.log, escreverErro = console.error } = {}) {
    let argumentos;
    let preparado;
    try {
        argumentos = lerArgumentos(argv);
        const backup = JSON.parse(readFileSync(argumentos.arquivo, 'utf8'));
        preparado = montarDocumentosDoBackup(backup);
    } catch (erro) {
        escreverErro(`ERRO: ${erro.message}`);
        escreverErro('Nenhuma alteração foi feita.');
        return 1;
    }

    const app = initializeApp({ projectId: argumentos.projeto }, `restauracao-${Date.now()}`);
    try {
        const db = getFirestore(app);
        const classificados = await classificarDocumentos(db, preparado.documentos);
        const contagem = contar(classificados);
        escrever(argumentos.aplicar ? 'MODO: APPLY' : 'MODO: DRY-RUN (nenhuma gravação)');
        imprimirResumo(escrever, argumentos.projeto, preparado.totais, contagem);

        if (contagem.CONFLICT > 0) {
            escrever('');
            escrever('Documentos em conflito (existem no destino com conteúdo diferente):');
            classificados.filter(item => item.acao === 'CONFLICT').forEach(item => escrever(`  ${item.caminho}`));
            escrever('');
            escrever(argumentos.aplicar ? 'APPLY BLOQUEADO: nada foi gravado.' : 'O --apply será recusado enquanto houver conflito.');
            return 2;
        }
        if (!argumentos.aplicar) {
            escrever('');
            escrever('Dry-run concluído. Use --apply para gravar.');
            return 0;
        }

        const gravados = await aplicarRestauracao(db, classificados);
        // Conferência: depois de gravar, todo documento do backup precisa estar igual no destino.
        const verificacao = contar(await classificarDocumentos(db, preparado.documentos));
        escrever('');
        escrever(`Gravados: ${gravados}`);
        if (verificacao.CREATE !== 0 || verificacao.CONFLICT !== 0) {
            escreverErro(`ERRO: verificação pós-gravação falhou (CREATE ${verificacao.CREATE}, CONFLICT ${verificacao.CONFLICT}).`);
            return 1;
        }
        escrever('Verificação: todos os documentos do backup estão iguais no destino.');
        return 0;
    } catch (erro) {
        escreverErro(`ERRO: ${erro.message}`);
        escreverErro('A execução parou. Rodar de novo é seguro: o que já foi gravado aparece como SKIP.');
        return 1;
    } finally {
        await deleteApp(app);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await executar(process.argv.slice(2));
}
