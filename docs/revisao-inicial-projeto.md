# Revisão inicial do Sistema de Orçamentos Filippini Cortinas

## Conclusão

O produto cobre boa parte do fluxo operacional descrito pela Filippini e o arquivo JavaScript passa na verificação básica de sintaxe. A base, porém, ainda não está pronta para receber novas funcionalidades com segurança. Antes de ampliar o escopo, é recomendável corrigir riscos de publicação, recuperação de dados, segurança, integridade dos orçamentos e processo de entrega.

Esta revisão não altera o comportamento do sistema. Os itens são recomendações para priorização e validação.

## Escopo revisado

- Código e configuração da aplicação web.
- README, plano de migração e checklist existentes.
- Documentos de contexto, fluxo e lista de tarefas.
- Screenshots representativos do catálogo, orçamento e edição de produto.
- Estrutura do repositório e histórico Git disponível.

Não foi possível validar as regras implantadas no Firestore porque elas não fazem parte do repositório. Também não foram executados fluxos autenticados contra dados de produção.

## Prioridade crítica antes de novas funcionalidades

### 1 Isolar os arquivos publicados pelo Firebase Hosting

O Hosting usa a raiz do projeto como diretório público e ignora somente arquivos de configuração, arquivos ocultos e `node_modules`. Um deploy realizado a partir da pasta atual pode incluir README, documentação interna, documentos Word, screenshots, tutoriais em vídeo, gravações de tela e PDFs de orçamento. O `.gitignore` não protege esses arquivos do Firebase Hosting.

**Resultado esperado:** publicar apenas os arquivos necessários à aplicação ou manter uma lista de exclusão completa e testada, com verificação do pacote antes de cada deploy.

### 2 Versionar e testar as regras de acesso aos dados

As regras do Firestore e os índices não estão no repositório. O front-end acessa coleções globais e não demonstra controle de papel, escopo por usuário ou empresa. Autenticação por si só não garante autorização adequada.

**Resultado esperado:** regras versionadas, testes no emulador, papéis definidos e acesso mínimo necessário para catálogo, configurações e orçamentos.

### 3 Tornar backup e restauração verdadeiros e completos

A exportação JSON não inclui unidades de medida. A função de importação chama `salvarDados` e `carregarDados`, que não existem no código atual, e não há ligação visível dessa restauração com a interface. O comando chamado de limpeza total apaga apenas `localStorage` e os arrays em memória; após recarregar, o Firestore repõe os dados.

**Resultado esperado:** backup de todas as entidades e metadados, validação de versão, prévia, restauração para o Firestore, proteção contra substituição acidental, relatório do resultado e teste periódico de recuperação.

### 4 Preservar todo o estado comercial do orçamento

Tipo de cliente, desconto global e opções de exibição da proposta dependem atualmente de controles da tela e não são carregados como estado próprio de cada orçamento. Isso impede reproduzir com confiança a proposta emitida e pode misturar condições ao alternar entre orçamentos.

**Resultado esperado:** cada orçamento ou versão deve guardar regras, parâmetros, conteúdo exibido, totais, timestamps, autoria e um retrato suficiente para reconstruir a proposta.

### 5 Eliminar inserção de dados como HTML não confiável

Dados de produtos, clientes, ambientes e observações são interpolados em várias atribuições a `innerHTML`. Como esses valores podem vir do usuário, de CSV ou do Firestore, um conteúdo malicioso pode se transformar em código executável no navegador.

**Resultado esperado:** renderização por APIs de texto ou sanitização consistente, política de segurança de conteúdo e testes com entradas adversas.

### 6 Garantir unicidade e concorrência

O próximo número de orçamento é calculado no navegador procurando lacunas e depois gravado com esse número como ID. Dois usuários podem escolher o mesmo número ao mesmo tempo, e números excluídos são reutilizados. A verificação de código de produto também usa apenas o estado local antes de criar um documento com ID aleatório.

**Resultado esperado:** geração atômica de números, política explícita de não reutilização, unicidade garantida no banco e tratamento claro de conflitos.

### 7 Corrigir ciclo de vida dos listeners e falhas de sincronização

Somente o listener de orçamentos guarda a função de cancelamento. Os listeners de preços, fornecedores, categorias e unidades continuam ativos após logout e podem ser duplicados em um novo login. Os listeners também não apresentam callbacks de erro nem um estado visível de sincronização.

**Resultado esperado:** anexar e remover todos os listeners de forma simétrica, evitar duplicidade e mostrar carregamento, offline, conflito e falha.

### 8 Separar homologação e produção

O checklist atual orienta a executar `firebase deploy` depois de cada alteração. Isso coloca mudanças diretamente em produção sem exigir testes, aprovação, prévia ou reversão.

**Resultado esperado:** projeto ou canal de homologação, preview por alteração, checklist de release, backup prévio, aprovação e rollback documentado.

## Prioridade alta para estabilização

### 9 Criar testes automatizados para as regras financeiras

Os cálculos de unidade, metro linear, metro quadrado, markup, comissão, desconto, instalação, margem e arredondamento são centrais ao negócio e não possuem testes automatizados no repositório. Há ainda um trecho inalcançável na descrição do cálculo de metro linear e validação incompleta da quantidade em itens por metro quadrado.

**Resultado esperado:** exemplos homologados pelo cliente transformados em testes unitários, além de testes de regressão para edição, duplicação e troca do tipo de cliente.

### 10 Testar os fluxos críticos de ponta a ponta

Não existe infraestrutura de testes, lint, integração contínua ou validação automatizada do HTML. O sistema depende de muitos elementos do DOM, modais, exportações e chamadas ao Firestore.

**Resultado esperado:** testes com o Firebase Emulator Suite para login, catálogo, orçamento, proposta, importação, pedido ao fornecedor, backup e restauração.

### 11 Modularizar a aplicação

`apps.js` possui aproximadamente 3.800 linhas e `index.html` aproximadamente 1.800 linhas, incluindo todo o CSS. Estado, acesso a dados, cálculos, renderização, modais e exportações estão acoplados. Isso aumenta o risco de regressão e dificulta testar regras isoladamente.

**Resultado esperado:** separar domínio financeiro, repositórios Firebase, estado, componentes de interface, importação e exportação em módulos com contratos claros.

### 12 Definir uma estratégia de dados para orçamentos grandes

Cada orçamento guarda arrays aninhados e é sobrescrito como um único documento. Esse modelo está sujeito ao limite de tamanho de documento do Firestore, a colisões de edição e a atualizações mais caras conforme o orçamento cresce.

**Resultado esperado:** definir volume esperado, subcoleções ou outra modelagem quando necessário, timestamps, versão de esquema e estratégia de migração.

### 13 Definir a política de congelamento do catálogo

Os itens guardam parte dos dados do produto, mas a exportação do pedido procura novamente o produto no catálogo atual. Se o produto for excluído, a exportação pode falhar; se custo ou fornecedor mudar, o pedido pode divergir da proposta original.

**Resultado esperado:** decidir quais dados são congelados na proposta, quais devem usar o catálogo vigente e como divergências são apresentadas e aprovadas.

### 14 Tornar mudanças de cadastros referenciais seguras

Produtos armazenam fornecedor, categoria e unidade pelo nome. Renomear esses cadastros exige atualizar muitos documentos. Operações em lote têm limite e, no caso do fornecedor, o cadastro é atualizado antes do lote de produtos, permitindo estado parcial se a segunda etapa falhar.

**Resultado esperado:** referências estáveis por ID, nomes como dados exibidos e migrações divididas, retomáveis e auditáveis.

### 15 Controlar limites da importação CSV

Uma única operação em lote tenta criar ou atualizar produtos, fornecedores e categorias. Arquivos grandes podem ultrapassar os limites do Firestore, e a unicidade continua dependente do retrato local.

**Resultado esperado:** importação em lotes controlados, validação completa, relatório por linha, retomada segura e teste de volume.

### 16 Melhorar a experiência em telas menores

A única regra `@media` é voltada à impressão. Há tabelas com muitas colunas e os screenshots mostram conteúdo denso e largo. A lista de tarefas já registra responsividade como pendência.

**Resultado esperado:** priorizar os fluxos realmente usados em celular ou tablet, reorganizar formulários e oferecer visualizações adequadas em vez de apenas rolagem horizontal.

### 17 Melhorar acessibilidade e interação

O CSS remove o contorno de foco de campos, modais não declaram semântica de diálogo e não há tratamento aparente de foco, Escape ou retorno ao controle de origem. Existem handlers HTML inline que tentam chamar funções de um módulo ES; essas funções não ficam disponíveis globalmente e podem gerar erros, embora alguns controles também tenham listeners JavaScript.

**Resultado esperado:** foco visível, navegação por teclado, modais acessíveis, mensagens anunciáveis e eventos registrados apenas pelo módulo.

### 18 Corrigir terminologia e consistência visual

O cadastro usa markup, mas a tabela chama a mesma coluna de margem e exibe um multiplicador como `1.5x`. Os nomes ligados a metro linear alternam entre altura padrão e largura do material. Essa inconsistência dificulta a conferência das fórmulas.

**Resultado esperado:** glossário aprovado e os mesmos termos na tela, proposta, exportações, ajuda e testes.

### 19 Melhorar mensagens e prevenção de ações destrutivas

O sistema usa dezenas de `alert` e `confirm`, inclusive em operações frequentes. Não há progresso para operações demoradas, bloqueio contra duplo clique, resumo detalhado de falhas ou possibilidade de desfazer.

**Resultado esperado:** feedback contextual, estados de processamento, confirmação proporcional ao risco e resultado verificável por operação.

### 20 Gerenciar dependências e políticas do navegador

Firebase, SheetJS e fontes são carregados diretamente de CDNs. Não há manifesto de dependências, integridade de recurso, política de segurança de conteúdo ou processo automatizado de atualização e teste.

**Resultado esperado:** versões e origem controladas, revisão de atualizações, cabeçalhos de segurança e estratégia de continuidade quando uma dependência externa falhar.

## Evoluções de produto a validar após a estabilização

- Histórico de preços e autoria das alterações.
- Versões comparáveis e reversíveis do orçamento.
- Estados da proposta e histórico de envios.
- Cenários comerciais salvos e margem mínima.
- Lembretes de validade e retorno ao cliente.
- Compartilhamento por WhatsApp com conteúdo e registro definidos.
- Templates de proposta.
- Indicadores de conversão, margem e prazo.
- Atalhos, ajuda contextual e tutorial integrado.

## Decisões que o cliente precisa ajudar a fechar

1. Papéis de usuário e permissões.
2. Uso simultâneo e volume esperado.
3. Regra definitiva de markup, margem, comissão, desconto e arredondamento.
4. Política de preço para orçamento em rascunho, enviado e aprovado.
5. Numeração, versão e estados do orçamento e da proposta.
6. Dados exigidos nas saídas de cliente, fornecedor, confecção e instalação.
7. Dispositivos prioritários e necessidade real de uso móvel.
8. Retenção e exclusão de dados pessoais.
9. Processo de homologação, aprovação e publicação.

## Ordem recomendada para o próximo ciclo

1. Receber e registrar os pedidos do cliente no PRD.
2. Homologar regras financeiras e ciclo de vida da proposta.
3. Fechar os riscos críticos de publicação, autorização, backup e integridade.
4. Criar a base de testes e o ambiente de homologação.
5. Priorizar funcionalidades novas por valor, risco e dependência.
6. Implementar somente os itens aprovados, em entregas pequenas e verificáveis.
