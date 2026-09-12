# PRD do Sistema de Orçamentos Filippini Cortinas

## Controle do documento

| Campo | Valor |
| --- | --- |
| Status | Em evolução, com entregas pendentes de validação operacional |
| Versão | 0.3 |
| Última atualização | 12 de setembro de 2026 |
| Responsável pelo produto | A definir |
| Aprovadores | A definir |
| Próxima revisão | Após a resposta às dúvidas do levantamento de 29 de agosto de 2026 |

Este documento estabelece uma base única para registrar o problema, as regras de negócio, o escopo, os critérios de aceite e as decisões do Sistema de Orçamentos Filippini Cortinas. Os requisitos FR 011 a FR 017 foram implementados e aguardam validação operacional conjunta; os demais continuam candidatos até aprovação específica.

## 1 Resumo do produto

O sistema apoia a elaboração de orçamentos de cortinas, persianas, cabeceiras e toldos. Ele substitui partes do processo anteriormente executado em planilhas: consulta do catálogo e dos preços de compra, aplicação de markup, composição de produtos acabados, agrupamento por ambiente, cálculo de margem, preparação da proposta ao cliente e geração do pedido aos fornecedores.

A aplicação atual é uma interface web estática integrada ao Firebase Authentication e ao Cloud Firestore. O catálogo, as configurações e os orçamentos são sincronizados em tempo real. A proposta pode ser impressa ou salva em PDF pelo navegador, e o pedido aos fornecedores pode ser exportado para Excel.

## 2 Contexto e problema

O processo comercial depende de medições realizadas no local, consulta a diferentes tabelas de fornecedores e combinação de vários componentes para formar um produto final. Sem regras centralizadas, o trabalho fica sujeito a consulta manual, retrabalho, erros de cálculo, perda de histórico e dificuldade para acompanhar negociações.

O produto deve tornar o orçamento reproduzível e confiável: uma proposta emitida precisa preservar os dados, preços, regras e decisões comerciais usados naquele momento, ainda que o catálogo mude depois.

## 3 Visão do produto

Disponibilizar uma ferramenta segura e simples para conduzir o orçamento desde o cadastro do catálogo até o fechamento da proposta e a preparação das compras e da instalação, mantendo rastreabilidade suficiente para a operação comercial.

## 4 Usuários e necessidades

### 4.1 Usuário comercial e orçamentista

Precisa localizar produtos rapidamente, montar composições por ambiente, testar condições comerciais, entender a margem e produzir uma proposta clara para o cliente.

### 4.2 Administrador do catálogo

Precisa cadastrar e atualizar produtos, fornecedores, categorias, unidades de medida, preços de compra e markup sem comprometer orçamentos já emitidos.

### 4.3 Responsável por compras

Precisa transformar uma proposta aprovada em pedidos separados por fornecedor, com quantidades, especificações e custos consistentes.

### 4.4 Instalador e equipe de confecção

Precisam receber instruções operacionais, ambientes, medidas, observações, responsável pela costura, responsável pela instalação e data prevista.

### 4.5 Gestor

Precisa acompanhar propostas, conversão, margem, descontos, prazos e riscos sem depender da interpretação manual de cada orçamento.

Os papéis, permissões e a possibilidade de uma mesma pessoa exercer mais de um papel ainda precisam ser confirmados.

## 5 Objetivos

- Reduzir o tempo necessário para elaborar e revisar um orçamento.
- Diminuir erros de preço, quantidade, medida, comissão, desconto e margem.
- Preservar o histórico comercial e permitir reproduzir propostas emitidas.
- Organizar o catálogo e a atualização de preços dos fornecedores.
- Gerar saídas adequadas ao cliente, aos fornecedores e à instalação.
- Proteger dados comerciais e pessoais e permitir recuperação após falhas.

## 6 Fora do escopo até nova aprovação

- Alterações funcionais ou técnicas sem requisito e critério de aceite aprovados.
- Integrações contábeis, fiscais, de pagamento ou ERP não confirmadas pelo cliente.
- Aplicativo móvel nativo.
- Automação de mensagens ou envio externo sem definição de consentimento, conteúdo e responsabilidade.
- Painéis gerenciais cujas métricas e fontes ainda não tenham sido validadas.

## 7 Capacidades existentes

| Área | Capacidade observada | Situação no PRD |
| --- | --- | --- |
| Acesso | Login e logout com Firebase Authentication | Existente, requer revisão de segurança e papéis |
| Catálogo | Cadastro, edição, exclusão, busca, filtros, ordenação e paginação de produtos | Existente |
| Configurações | Gestão de fornecedores, categorias e unidades de medida | Existente |
| Importação | Importação de catálogo por CSV com pré-validação | Existente, requer limites e testes |
| Orçamentos | Criação, duplicação, exclusão e seleção de orçamentos | Existente |
| Composição | Produtos acabados e itens avulsos agrupados por ambiente | Existente |
| Cálculos | Preço de venda, comissão de arquiteto, custo e margem | Existente, regras precisam ser homologadas |
| Proposta | Resumo, detalhamento opcional, condições comerciais e impressão | Existente |
| Operação | Instruções ao instalador e pedido Excel por fornecedor | Existente |
| Persistência | Firestore com listeners em tempo real | Existente, requer reforço de integridade |
| Backup | Exportação JSON e restauração por mesclagem em lotes | Implementado, pendente de teste periódico de recuperação |

## 8 Fluxo principal atual

1. O usuário acessa o sistema e se autentica.
2. O catálogo é consultado ou atualizado com produtos, custos, fornecedores, categorias, unidades e markup.
3. O usuário cria ou seleciona um orçamento e registra cliente, endereço, datas, prazo e observações.
4. O usuário cria produtos acabados por ambiente e adiciona seus componentes, ou inclui itens avulsos.
5. O sistema calcula preço de venda, comissão e margem conforme a unidade de medida e o tipo de cliente.
6. O usuário define instalação, desconto, forma e condição de pagamento.
7. O sistema monta a proposta ao cliente e as instruções ao instalador.
8. Após aprovação, o usuário gera a planilha de compras separada por fornecedor.

O fluxo futuro deve incluir estados formais da proposta, versões, aprovação, fechamento, compra e instalação, caso isso seja confirmado pelo cliente.

### 8.1 Feedback do cliente recebido em 29 de agosto de 2026

O cliente relatou que a proposta impressa está extensa demais. No exemplo apresentado, uma cortina de um único ambiente ocupou duas páginas; em trabalhos com dez ambientes, a saída pode chegar a dezenas de páginas. Como referência de densidade, ele espera que um caso típico de um ambiente ocupe aproximadamente meia página quando houver detalhamento dos itens e cerca de um terço de página na versão reduzida.

Também foi solicitado um estado de pedido distinto do orçamento. Quando o orçamento virar pedido, os itens e custos usados na compra devem ficar congelados: uma alteração posterior na tabela de preços não pode modificar o pedido já confirmado.

Para a saída destinada ao fornecedor, o cliente deseja um documento mais simples. Os dados explicitamente solicitados são nome do cliente, nome da costureira, endereço da costureira como endereço de entrega e itens do pedido. Deve existir a opção de ocultar custos. Para o instalador, a saída deve apresentar nome e endereço do cliente e os itens que precisam ser retirados na confecção.

As observações das fotografias e a proposta de outra empresa foram tratadas como referência de problema e de densidade visual, não como especificação pronta nem como autorização para copiar identidade visual.

## 9 Regras de negócio a homologar

### 9.1 Formação de preço

- O preço-base de venda é calculado pelo preço de compra multiplicado pelo markup do produto.
- O significado de markup e margem deve permanecer distinto na interface e nos relatórios.
- Deve ser definido se o arredondamento ocorre por unidade, por item, por ambiente ou apenas no total.

### 9.2 Unidades de medida

- Unidade: preço multiplicado pela quantidade.
- Metro linear: preço multiplicado pela metragem ou quantidade informada, com largura ou altura padrão do material disponível como dado técnico.
- Metro quadrado: largura multiplicada pela altura e pela quantidade de peças.
- Outras unidades só devem ser aceitas após definição de sua fórmula e dos campos obrigatórios.

### 9.3 Comissão de arquiteto

- A implementação atual acrescenta 10% ao preço-base quando o tipo de cliente é arquiteto.
- É necessário confirmar base de cálculo, arredondamento, incidência de desconto, apresentação ao cliente e momento de pagamento.

### 9.4 Instalação

- O valor é informado por ambiente e apresentado separadamente dos produtos.
- A proposta informa que o pagamento é feito diretamente ao instalador.
- É necessário confirmar se instalação participa de desconto, comissão, margem e status de recebimento.

### 9.5 Desconto

- O desconto global incide atualmente sobre produtos, não sobre instalação.
- Deve haver limite, alçada de aprovação e alerta de margem mínima, se aplicável.

### 9.6 Preço histórico e orçamento emitido

- Deve ser decidido se um orçamento preserva um retrato dos dados do produto no momento da inclusão ou se acompanha mudanças posteriores do catálogo.
- Propostas emitidas ou aprovadas não devem mudar silenciosamente.

### 9.7 Numeração e versões

- O número comercial do orçamento deve ser único e não reutilizável.
- Revisões de negociação devem ter versão própria sem perder o histórico anterior.

### 9.8 Transformação de orçamento em pedido

- O orçamento deve possuir um estado explícito que permita identificar quando ele ainda é uma proposta e quando foi confirmado como pedido.
- A transformação deve registrar data, responsável e versão de origem.
- O pedido deve preservar um retrato dos produtos, fornecedores, medidas, quantidades e custos usados na confirmação.
- Mudanças posteriores no catálogo ou na tabela de preços não podem alterar automaticamente pedidos existentes.
- Alterações necessárias após a confirmação devem seguir uma regra de revisão ou aditivo ainda a definir.

### 9.9 Apresentação compacta da proposta

- A proposta deve oferecer pelo menos uma visualização reduzida e uma visualização detalhada.
- A versão reduzida deve priorizar ambiente, produto acabado, descrição comercial, valor do ambiente e totais.
- A versão detalhada pode apresentar componentes, quantidades e valores conforme as opções escolhidas.
- Observações específicas do produto devem aparecer junto ao produto correspondente, e não somente ao final do documento.
- O layout deve reduzir espaços vazios e quebras desnecessárias sem comprometer legibilidade.

### 9.10 Saídas operacionais

- O pedido ao fornecedor deve usar os dados congelados no momento da confirmação do pedido.
- O conteúdo deve variar conforme o destinatário: cliente, fornecedor, costureira ou instalador.
- Custos de compra são dados internos e só devem aparecer quando a opção e a permissão correspondentes estiverem ativas.
- O relatório do instalador não deve apresentar valores comerciais.

## 10 Escopo funcional candidato

Os itens abaixo são candidatos para discussão e não representam compromisso de implementação.

| ID | Requisito candidato | Resultado esperado | Prioridade | Status |
| --- | --- | --- | --- | --- |
| FR 001 | Histórico e versões de orçamento | Comparar, restaurar e identificar cada proposta enviada | A definir | A validar |
| FR 002 | Ciclo de vida da proposta | Registrar rascunho, enviada, em negociação, aprovada, rejeitada, expirada e cancelada | A definir | A validar |
| FR 003 | Histórico de preços | Consultar alterações de custo e markup por produto | A definir | A validar |
| FR 004 | Cenários comerciais | Salvar simulações de desconto e comparar margem | A definir | A validar |
| FR 005 | Margem mínima e alçadas | Alertar ou bloquear condição abaixo da política aprovada | A definir | A validar |
| FR 006 | Compartilhamento controlado | Gerar e registrar o envio da proposta por canal aprovado | A definir | A validar |
| FR 007 | Lembretes | Alertar sobre validade, retorno e próximos passos | A definir | A validar |
| FR 008 | Relatórios gerenciais | Exibir métricas homologadas de vendas, margem e conversão | A definir | A validar |
| FR 009 | Experiência móvel | Permitir consulta e operação dos fluxos prioritários em telas menores | A definir | A validar |
| FR 010 | Backup e restauração | Recuperar todos os dados com validação, prévia e auditoria | Alta | Necessidade confirmada, solução a definir |
| FR 011 | Proposta compacta | Reduzir drasticamente o número de páginas com modos reduzido e detalhado | Alta | Implementado, pendente de validação operacional |
| FR 012 | Transformar orçamento em pedido | Alterar formalmente o estado e registrar a confirmação comercial | Alta | Implementado, pendente de validação operacional |
| FR 013 | Congelamento do pedido | Impedir que mudanças futuras no catálogo alterem itens e custos confirmados | Alta | Implementado, exceções ainda a definir |
| FR 014 | Pedido simplificado ao fornecedor | Exibir apenas identificação operacional, entrega e itens necessários | Alta | Implementado, campos finais a validar |
| FR 015 | Relação para o instalador | Informar cliente, endereço e itens a retirar na confecção | Alta | Implementado, campos finais a validar |
| FR 016 | Visibilidade de custos | Permitir gerar a saída com ou sem custos, conforme destinatário e permissão | Alta | Implementado com custos ocultos por padrão |
| FR 017 | Observações junto ao produto | Apresentar a observação específica no bloco do produto correspondente | Média | Implementado, pendente de validação operacional |

## 11 Modelo conceitual de dados

| Entidade | Conteúdo principal | Relações e observações |
| --- | --- | --- |
| Usuário | Identidade, estado e papel | Deve determinar permissões e autoria |
| Produto | Código, descrição, cor, custo, markup, unidade, fornecedor, categoria e status | Código precisa ser único |
| Histórico de preço | Produto, valores anterior e novo, data e autor | Candidato |
| Fornecedor | Nome, status e dados operacionais | Referenciado por produto e pedido |
| Categoria | Nome e status | Referenciada por produto |
| Unidade de medida | Nome, status e regra de cálculo | A regra não deve depender apenas do texto exibido |
| Orçamento | Número, versão, estado, cliente, datas, condições e totais | Deve ter autoria e timestamps |
| Produto acabado | Nome, ambiente, instruções e componentes | Pertence ao orçamento |
| Item do orçamento | Retrato do produto, medidas, quantidades, preços, comissão e margem | Deve preservar a base do cálculo |
| Instalação | Ambiente, valor, data, instalador e estado | Pertence ao orçamento |
| Proposta emitida | Versão, conteúdo, data, canal e destinatário | Candidato |
| Pedido ao fornecedor | Fornecedor, itens, custos e estado | Candidato |

## 12 Requisitos não funcionais

### 12.1 Segurança e privacidade

- As regras do Firestore devem ser versionadas, revisadas e testadas.
- O acesso deve seguir o papel do usuário e o princípio do menor privilégio.
- Dados pessoais e comerciais não devem ser publicados junto aos arquivos estáticos.
- Entradas de usuário ou do banco não podem ser inseridas como HTML executável.
- A política de retenção, exclusão, exportação e acesso deve considerar a LGPD.

### 12.2 Integridade e confiabilidade

- Operações críticas devem ser atômicas ou idempotentes quando aplicável.
- O sistema deve impedir duplicidade de códigos e números mesmo com usuários simultâneos.
- A proposta deve continuar reproduzível após mudanças no catálogo.
- Backup e restauração devem abranger todas as entidades e ser testados periodicamente.

### 12.3 Desempenho

- Busca, listagem e sincronização devem permanecer utilizáveis com o volume esperado de produtos e orçamentos.
- Limites de documentos, consultas e operações em lote do Firestore devem ser considerados.
- Metas de volume e tempo de resposta serão definidas após medição do uso real.

### 12.4 Usabilidade e acessibilidade

- Os fluxos prioritários devem funcionar em desktop e nos tamanhos de tela confirmados pelo cliente.
- Controles devem ter rótulos, foco visível, uso por teclado e mensagens compreensíveis.
- Tabelas extensas precisam de leitura e navegação adequadas em telas menores.
- Termos comerciais e de cálculo devem ser consistentes em todas as telas e saídas.

### 12.5 Operação e observabilidade

- Falhas de autenticação, leitura, gravação, exportação e sincronização devem ser detectáveis.
- O usuário deve distinguir carregamento, sucesso, erro, modo offline e conflito.
- Deve existir ambiente de homologação, processo de publicação e caminho de reversão.

## 13 Métricas de sucesso

As metas dependem de uma linha de base ainda não coletada.

| Métrica | Linha de base | Meta | Fonte |
| --- | --- | --- | --- |
| Tempo médio para criar uma proposta | A medir | A definir | Eventos do fluxo |
| Percentual de propostas com correção após envio | A medir | A definir | Histórico de versões |
| Erros de cálculo ou preço identificados | A medir | A definir | Registro de incidentes |
| Conversão de proposta para aprovação | A medir | A definir | Estado da proposta |
| Margem média e dispersão por proposta | A medir | A definir | Dados financeiros |
| Tempo entre envio e decisão do cliente | A medir | A definir | Histórico de estados |
| Recuperação bem-sucedida de backup | Não testada | 100% nos testes periódicos | Teste de restauração |

## 14 Critérios de aceite padrão

Cada requisito aprovado deve conter critérios verificáveis no formato Dado Quando Então, incluindo:

- caminho principal;
- campos obrigatórios e validações;
- permissões por papel;
- persistência e sincronização;
- arredondamento e exemplos de cálculo;
- estados vazios, carregamento, erro, offline e conflito;
- comportamento em desktop e telas menores aplicáveis;
- impacto em proposta, fornecedor, instalação, histórico e backup;
- migração ou compatibilidade com dados existentes;
- evidência de teste e aprovação do responsável pelo produto.

## 15 Estratégia de validação e entrega

1. Registrar o pedido do cliente e o problema que ele pretende resolver.
2. Esclarecer regras, exceções, usuários e impacto nos fluxos existentes.
3. Definir prioridade, dependências, riscos e critérios de aceite.
4. Obter aprovação explícita do escopo.
5. Preparar desenho técnico e plano de testes.
6. Implementar em ambiente de desenvolvimento ou homologação.
7. Executar testes automatizados e validação do usuário.
8. Publicar com backup, checklist e possibilidade de reversão.
9. Medir o resultado e atualizar este PRD e o registro de decisões.

## 16 Riscos principais

- Divergência entre a regra comercial praticada e a fórmula implementada.
- Alteração retroativa de uma proposta quando o catálogo muda.
- Perda ou exposição de dados por publicação, permissão ou restauração inadequada.
- Sobrescrita de mudanças quando mais de um usuário edita o mesmo orçamento.
- Crescimento de documentos de orçamento além dos limites do banco.
- Acúmulo de novas funcionalidades antes da estabilização dos fluxos críticos.

## 17 Questões abertas

1. Quantas pessoas usam o sistema e quantas podem trabalhar simultaneamente?
2. Quais papéis precisam existir e o que cada papel pode consultar ou alterar?
3. O sistema atenderá apenas a Filippini ou poderá atender outras unidades ou empresas?
4. Qual é o volume atual e esperado de produtos, orçamentos e propostas por ano?
5. Quais estados representam o ciclo comercial completo da proposta?
6. Quando um preço muda, orçamentos em rascunho devem ser atualizados ou preservados?
7. Quais regras exatas determinam markup, margem mínima, comissão e desconto?
8. O número de um orçamento excluído pode ser reutilizado?
9. Quais dados precisam aparecer para cliente, fornecedor, costureira e instalador?
10. Quais canais de envio precisam ser integrados e quais registros devem ser guardados?
11. Por quanto tempo dados de clientes e propostas devem ser mantidos?
12. Quais dispositivos e navegadores são usados no trabalho real?
13. Qual ação ou estado confirma que um orçamento virou pedido: aprovação, botão dedicado ou mudança manual de status?
14. Depois da confirmação, quais alterações continuam permitidas e quais exigem uma nova versão do pedido?
15. O endereço da costureira deve ficar em um cadastro permanente ou ser informado em cada pedido?
16. Além de cliente, costureira, endereço de entrega e itens, o pedido ao fornecedor deve manter número do pedido, data, fornecedor e prazo?
17. A saída de fornecedor deve ser um arquivo por fornecedor, um arquivo com abas ou ambos?
18. A opção de ocultar custos deve vir desmarcada por padrão e quem pode alterá-la?
19. O relatório do instalador também deve manter data de instalação, nome do instalador e instruções específicas do produto?
20. Quais observações pertencem à proposta do cliente, ao fornecedor e ao instalador?
21. Na proposta reduzida, devem aparecer somente os totais por ambiente ou também uma descrição técnica resumida de cada produto?
22. As metas de meia página e um terço de página devem ser avaliadas em A4, com quais margens e tamanho mínimo de fonte?

## 18 Modelo para novos pedidos do cliente

### Identificação

- Título do pedido:
- Solicitante:
- Data:
- Urgência informada:
- Usuários afetados:

### Problema

- O que acontece hoje:
- Qual dificuldade ou risco isso causa:
- Com que frequência acontece:
- Exemplo real:

### Resultado desejado

- Comportamento esperado:
- Benefício esperado:
- Como saberemos que funcionou:

### Regras e exceções

- Regra principal:
- Exceções:
- Campos e dados necessários:
- Permissões:
- Impacto em cálculos:
- Impacto em documentos e exportações:

### Critérios de aceite

- Dado:
- Quando:
- Então:
- Cenários de erro:

### Decisão

- Prioridade:
- Escopo aprovado:
- Fora do escopo:
- Dependências:
- Aprovador:
- Data da aprovação:

## 19 Registro de mudanças

| Versão | Data | Alteração | Autor | Aprovação |
| --- | --- | --- | --- | --- |
| 0.1 | 12 de setembro de 2026 | Criação do PRD-base a partir do produto e da documentação existentes | Codex | Pendente |
| 0.2 | 12 de setembro de 2026 | Incorporação do feedback, das anotações e das referências visuais recebidas em 29 de agosto de 2026 | Codex | Pendente |
| 0.3 | 12 de setembro de 2026 | Registro da implementação dos pedidos confirmados, relatórios compactos, restauração por mesclagem e módulo financeiro coberto por testes | Codex | Validação operacional pendente |
