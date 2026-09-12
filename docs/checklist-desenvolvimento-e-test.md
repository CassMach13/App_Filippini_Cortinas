Checklist de Desenvolvimento e Testes (Versão Firebase) 

Primeiro, vamos atualizar seu checklist. Ele é excelente para a lógica de negócio. Adicionei pontos cruciais sobre a camada de dados e a interação com o Firebase. Usaremos este guia ao final de cada fase.



Pontos de Atenção que NUNCA devem ser ignorados 

Sempre que possível, evitar reescrever o código pois ele está bem estruturado, ao invés, modificar apenas pequenos trechos ou funções isoladas.

Sempre atualize o meus arquivos diretamente, desta forma economizamos tempo e sua sugestão será quase que sempre aceita por mim pois sou o gestor de projetos e não um desenvolvedor.

Infraestrutura e Dados (Novos Itens) 

✅ Conexão: O app conecta-se ao Firebase sem erros no console? 

✅ Autenticação: O login/logout funciona e o app reage corretamente (mostrando/escondendo a UI)? 

✅ Carregamento Inicial: Todos os dados (produtos, orçamentos, etc.) são carregados do Firestore ao iniciar? 

✅ Consistência: Uma alteração feita (ex: novo produto) reflete em tempo real em todas as partes do app que usam aquele dado? 

✅ Operações CRUD (Create, Read, Update, Delete): 

A criação de um novo item (produto, orçamento, fornecedor) o salva corretamente no Firestore? 

A edição de um item atualiza o documento correto no Firestore? 

A exclusão de um item remove o documento correto do Firestore? 

✅ Tratamento de Erros: O app mostra mensagens amigáveis caso a conexão com o Firebase falhe? 

Lógica de Negócio (Seu Checklist Original, Mantido e Válido) 

✅ Aba 1 (Lista de Preços): Continua funcionando (adicionar, editar, excluir, filtrar, ordenar)? 

✅ Aba 2 (Lançamento de Orçamento): 

A coluna de margem aparece e é calculada corretamente ao adicionar/editar itens? 

Os resumos (por ambiente e geral) mostram as margens corretas? 

A função recalcularComissao() atualiza as margens corretamente? 

✅ Aba 3 (Proposta Cliente): A geração da proposta continua funcionando sem erros? 

✅ Aba 4 (Configurações): As funções de gerenciamento (fornecedores, categorias), importação/exportação e limpeza estão adaptadas para o Firebase? 

✅ Compatibilidade: Orçamentos criados antes da migração (se houver) são lidos corretamente? 

✅ Cálculo de Margem: A lógica considera todos os fatores (custo, comissão, unidade de medida)? 

✅ UI/UX: As cores indicativas de margem e a formatação de moeda/percentual estão corretas?

Antes de qualquer publicação, execute a checagem sintática, os testes automatizados e o teste de navegador. Publique somente quando todos passarem e a alteração estiver registrada no Git. Use primeiro `firebase deploy --dry-run` e, depois da validação, `firebase deploy --only hosting,firestore`.
