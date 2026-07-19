Plano de Ação: Migração Estruturada para Firebase
Vamos seguir este roteiro. Cada fase resolve uma parte do quebra-cabeça, construindo uma base sólida para a próxima.
________________________________________
Fase 1: Estrutura e Autenticação (A Base de Tudo)
Objetivo: Ter um sistema de login funcional que controla o acesso ao aplicativo. Nesta fase, ainda não vamos carregar os dados de negócio (produtos, orçamentos).
•	Tarefa 1.1: Refatorar a Estrutura do HTML - concluído
o	Subtarefa: Mover todo o seu código JavaScript de dentro da tag <script> no final do Filippini_V171.html para um arquivo separado chamado app.js.
o	Subtarefa: No final do <body>, substituir o <script type="module">...</script> por <script type="module" src="app.js"></script>. Isso organiza o projeto e melhora a manutenção.
•	Tarefa 1.2: Centralizar a Inicialização do Firebase - concluído
o	Subtarefa: Criar um arquivo chamado firebase-config.js.
o	Subtarefa: Mover a importação dos módulos do Firebase (initializeApp, getAuth, getFirestore, etc.) e a sua firebaseConfig para dentro de firebase-config.js.
o	Subtarefa: No final de firebase-config.js, exportar as instâncias que serão usadas no resto do app. Exemplo:
JavaScript
// firebase-config.js
// ... (imports e firebaseConfig)
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
export { auth, db };
•	Tarefa 1.3: Implementar o Controle de Acesso - concluído
o	Subtarefa: No app.js, importar auth do firebase-config.js.
o	Subtarefa: No app.js, modificar a função onAuthStateChanged para controlar a visibilidade da tela de login vs. a aplicação principal, como você já iniciou.
o	Subtarefa: Garantir que a função handleLogin (disparada pelo clique no botão "Entrar") chama signInWithEmailAndPassword e trata os erros (ex: 'auth/wrong-password'), exibindo mensagens claras para o usuário.
o	Subtarefa: Garantir que o botão "Sair" chame a função signOut(auth).
Resultado esperado ao final da Fase 1: O app carrega na tela de login. O usuário consegue entrar com email e senha, a tela de login some e a interface principal do sistema aparece (ainda vazia, sem dados). Ao clicar em "Sair", o usuário volta para a tela de login.
________________________________________
Fase 2: Leitura de Dados (Read-Only)
Objetivo: Fazer o aplicativo ler e exibir todos os dados das coleções principais (produtos, fornecedores, categorias) do Firestore. A escrita de dados ainda não funcionará.
•	Tarefa 2.1: Migrar a Função carregarDados
o	Subtarefa: Transformar carregarDados em uma função async.
o	Subtarefa: Dentro dela, remover todas as chamadas localStorage.getItem.
o	Subtarefa: Para cada tipo de dado (precos, fornecedores, etc.), usar getDocs para buscar a coleção correspondente no Firestore. Importante: Use await antes de cada chamada getDocs.
o	Subtarefa: Mapear o resultado do getDocs para o formato de array que seu código já espera (ex: precos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))). O id: doc.id é crucial para as operações de edição e exclusão futuras.
•	Tarefa 2.2: Ajustar a Inicialização do App
o	Subtarefa: Chamar await carregarDados() de dentro do onAuthStateChanged, logo após a autenticação bem-sucedida do usuário.
o	Subtarefa: Após o await carregarDados(), chame as funções que populam a UI (ex: filtrarProdutos(), atualizarSelects(), preencherInfoOrcamento()), pois agora você terá a garantia de que os dados já foram carregados.
Resultado esperado ao final da Fase 2: Ao fazer login, o usuário vê a "Lista de Preços" populada com os produtos do Firestore. Os filtros e a paginação funcionam. As abas de Orçamento e Proposta ainda não carregarão os dados corretamente, e isso é esperado.
________________________________________
Fase 3: Escrita de Dados (CRUD Completo)
Objetivo: Migrar todas as funções que criam, atualizam ou deletam dados para que operem no Firestore.
•	Tarefa 3.1: Migrar CRUD da "Lista de Preços"
o	Subtarefa: Refatorar adicionarPreco para usar addDoc (para novos produtos) ou setDoc/updateDoc (para edição).
o	Subtarefa: Refatorar excluirPreco para usar deleteDoc. Lembre-se que agora você tem o ID do documento (produto.id) para passar ao deleteDoc.
o	Subtarefa: Refatorar salvarEdicaoProduto da mesma forma.
•	Tarefa 3.2: Migrar CRUD das "Configurações" (Fornecedores, Categorias)
o	Subtarefa: Repetir o processo acima para as funções de gerenciamento: adicionarFornecedorModal, removerFornecedorModal, salvarEdicaoFornecedor, e suas equivalentes para Categorias e Unidades de Medida.
•	Tarefa 3.3: Migrar CRUD de "Orçamentos" (A parte mais complexa)
o	Subtarefa: Refatorar criarNovoOrcamento para usar addDoc na coleção orcamentos. Armazene o ID gerado pelo Firestore no objeto orcamentoAtualId.
o	Subtarefa: Refatorar excluirOrcamento para usar deleteDoc.
o	Subtarefa: Refatorar todas as funções que modificam um orçamento (adicionarItemAoOrcamento, removerItem, atualizarInfoOrcamento, salvarEdicaoProdutoAcabado, etc.). A estratégia aqui é:
1.	Modificar o objeto orcamento na memória (no array orcamentosSalvos).
2.	Usar setDoc ou updateDoc para salvar o objeto de orçamento inteiro e atualizado de volta no Firestore, usando orcamentoAtualId para identificar o documento. Ex: await setDoc(doc(db, 'orcamentos', orcamentoAtualId), orcamentoAtualizado);
Resultado esperado ao final da Fase 3: O aplicativo está 100% funcional. Todas as operações de criação, edição e exclusão de produtos, orçamentos e configurações são persistidas no Firebase.
________________________________________
Fase 4: Otimização com Tempo Real (Listeners)
Objetivo: Tornar o aplicativo reativo a mudanças no banco de dados em tempo real, eliminando a necessidade de recarregar os dados manualmente.
•	Tarefa 4.1: Implementar Listeners onSnapshot
o	Subtarefa: Criar funções separadas para "ouvir" cada coleção. Ex: escutarProdutos(), escutarOrcamentos().
o	Subtarefa: Dentro de cada uma, usar a função onSnapshot do Firestore. O callback do onSnapshot receberá os dados sempre que houver uma mudança.
o	Subtarefa: Dentro do callback, atualize o array local correspondente (precos, orcamentosSalvos, etc.) e chame as funções de renderização da UI (filtrarProdutos, renderizarItensOrcamento).
•	Tarefa 4.2: Integrar os Listeners
o	Subtarefa: Chamar essas funções de "escuta" uma única vez, logo após o login do usuário, no onAuthStateChanged.
o	Subtarefa: Remover as chamadas manuais a carregarDados() que foram adicionadas após as operações de escrita na Fase 3, pois o onSnapshot agora fará a atualização da UI automaticamente.
Resultado esperado ao final da Fase 4: O aplicativo está otimizado. Se você abrir o app em duas abas e adicionar um produto em uma, ele aparecerá instantaneamente na outra sem precisar recarregar a página.

