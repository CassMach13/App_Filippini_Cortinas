# Levantamento de requisitos do cliente em 29 de agosto de 2026

## Objetivo deste registro

Este documento transforma a mensagem e as quatro fotografias recebidas em necessidades de produto verificáveis. As falas e anotações são fontes de descoberta, não instruções técnicas nem aprovação para desenvolvimento. Informações pessoais visíveis nos exemplos não foram reproduzidas porque não são necessárias para especificar as funcionalidades.

## Fontes analisadas

- Mensagem transcrita do cliente sobre proposta, pedido ao fornecedor e relatório do instalador.
- Fotografias `WhatsApp Image 2026-08-29 at 11.12.23.jpeg` e `WhatsApp Image 2026-08-29 at 11.12.36.jpeg`, com a proposta atual impressa e anotações.
- Fotografia `WhatsApp Image 2026-08-29 at 11.13.28.jpeg`, com o pedido ao fornecedor e marcações dos campos dispensáveis e necessários.
- Fotografia `WhatsApp Image 2026-08-29 at 11.15.03.jpeg`, usada pelo cliente como referência de uma proposta mais compacta de outra empresa.

## Síntese do problema

A proposta atual consome espaço excessivo. Um orçamento de apenas um ambiente gerou duas páginas, e propostas maiores podem chegar a dezenas de páginas. O problema afeta impressão, leitura, envio ao cliente e uso cotidiano.

As saídas operacionais também precisam ser orientadas ao destinatário. O fornecedor e o instalador não necessitam de todo o cabeçalho comercial nem das mesmas informações apresentadas ao cliente. Além disso, um pedido confirmado precisa permanecer estável mesmo que a tabela de preços seja atualizada posteriormente.

## Necessidades confirmadas

### RC 001 Proposta compacta

**Problema:** a proposta atual repete blocos e usa espaço vertical demais.

**Resultado desejado:** gerar uma proposta curta e legível, adequada para impressão ou PDF, inclusive quando houver muitos ambientes.

**Regras preliminares:**

- Disponibilizar modo reduzido e modo detalhado.
- No caso típico de um ambiente, usar como meta aproximadamente um terço de página no modo reduzido e meia página no modo detalhado.
- No modo reduzido, evitar a lista completa de componentes quando ela não for necessária ao cliente.
- No modo detalhado, compactar a tabela de componentes sem perder identificação, descrição, unidade e quantidade.
- Manter totais, desconto e instalação claros, sem repetir informações desnecessárias.
- Evitar que o bloco de um ambiente ou produto seja quebrado de forma confusa entre páginas.

**Critérios de aceite preliminares:**

- Dado um orçamento típico de um ambiente, quando a versão reduzida for impressa em A4, então ela deve ocupar aproximadamente um terço de página sem texto ilegível.
- Dado o mesmo orçamento, quando a versão detalhada for impressa, então ela deve ocupar no máximo aproximadamente meia página, salvo conteúdo excepcionalmente longo.
- Dado um orçamento com vários ambientes, quando houver quebra de página, então títulos, descrições e seus valores devem permanecer visualmente associados.
- Dada uma configuração de conteúdo, quando o documento for reaberto ou reimpresso, então a mesma configuração deve ser preservada no orçamento ou na versão emitida.

### RC 002 Observações junto ao produto

**Problema:** uma observação relevante ao produto aparece distante, ao final da proposta.

**Resultado desejado:** mostrar a observação específica logo abaixo ou junto do produto acabado correspondente.

**Regras preliminares:**

- Separar observação geral, observação comercial, descrição do produto e instrução ao instalador.
- Não mostrar ao cliente uma instrução exclusivamente interna ou operacional.
- A observação do produto deve acompanhar o produto nas versões reduzida e detalhada quando estiver marcada para o cliente.

### RC 003 Estado de pedido

**Problema:** orçamento e pedido ainda não estão claramente separados no fluxo.

**Resultado desejado:** permitir que um orçamento aprovado seja formalmente transformado em pedido.

**Regras preliminares:**

- A mudança deve ser explícita e confirmada pelo usuário.
- Registrar número, versão de origem, data e responsável pela transformação.
- O sistema deve deixar claro se o registro está em orçamento, negociação ou pedido.
- A reversão ou alteração posterior deve seguir uma regra aprovada, sem apagar o histórico.

**Critérios de aceite preliminares:**

- Dado um orçamento ainda não aprovado, quando o usuário confirmar a transformação, então um pedido deve ser criado ou o registro deve mudar de estado com data, usuário e versão de origem.
- Dado um pedido confirmado, quando ele for consultado, então deve ser possível identificar de qual orçamento e versão ele se originou.

### RC 004 Congelamento dos dados do pedido

**Problema:** mudanças na tabela de preços podem alterar informações usadas na compra.

**Resultado desejado:** pedidos confirmados devem permanecer iguais ao momento da confirmação.

**Dados mínimos a congelar:**

- código e descrição do item;
- fornecedor;
- unidade de medida;
- medidas e quantidade de compra;
- preço de compra unitário;
- custo total;
- produto acabado e ambiente de origem;
- observações aplicáveis ao pedido.

**Critérios de aceite preliminares:**

- Dado um pedido confirmado, quando o preço de um produto for alterado no catálogo, então quantidade, preço e custo daquele pedido não devem mudar.
- Dado um pedido confirmado, quando um produto for inativado, renomeado ou excluído do catálogo, então o pedido deve continuar íntegro e exportável.
- Dada uma correção necessária no pedido, quando ela for autorizada, então a mudança deve gerar histórico ou nova revisão.

### RC 005 Pedido simplificado ao fornecedor

**Problema:** o relatório atual apresenta informações institucionais e comerciais que o cliente considera desnecessárias para o fornecedor.

**Campos explicitamente solicitados:**

- nome do cliente;
- nome da costureira;
- endereço da costureira, usado como endereço de entrega;
- itens do pedido.

**Conteúdo dos itens a validar:**

- código;
- descrição;
- unidade;
- quantidade solicitada;
- preço unitário, opcional;
- custo total, opcional.

**Campos marcados como dispensáveis na referência:**

- CNPJ;
- nome e telefone de contato;
- e-mail;
- redes sociais;
- demais dados institucionais sem utilidade para aquela compra.

**Critérios de aceite preliminares:**

- Dado um pedido com itens de mais de um fornecedor, quando a saída for gerada, então cada fornecedor deve receber apenas seus próprios itens.
- Dado que a exibição de custos esteja desativada, quando o documento for gerado, então preço unitário, custo por item e total de compra não devem aparecer.
- Dado um pedido congelado, quando a saída for gerada após uma alteração no catálogo, então ela deve manter os valores e dados do pedido.

### RC 006 Relação para o instalador

**Problema:** o instalador precisa de uma relação objetiva para retirada na confecção.

**Campos explicitamente solicitados:**

- nome do cliente;
- endereço do cliente;
- itens que precisam ser retirados na confecção.

**Regras preliminares:**

- Não apresentar preços, custos, margem, desconto ou condições de pagamento.
- Usar os itens do pedido confirmado, não uma leitura atual do catálogo.
- Organizar a relação de forma que o instalador consiga conferir a retirada.

**Critérios de aceite preliminares:**

- Dado um pedido confirmado, quando a relação do instalador for gerada, então ela deve conter cliente, endereço e todos os itens previstos para retirada.
- Quando a relação for impressa, então não deve apresentar nenhum valor financeiro.

### RC 007 Opção de ocultar custos

**Problema:** o custo do produto nem sempre deve aparecer na tela ou no documento gerado.

**Resultado desejado:** permitir controlar a apresentação dos custos conforme o uso e o destinatário.

**Regras preliminares:**

- A opção deve afetar preço unitário de compra, custo por item e total de compra.
- Ocultar a exibição não deve apagar nem recalcular o custo congelado.
- O acesso à opção pode depender do papel do usuário.
- O padrão ligado ou desligado ainda precisa ser definido.

## Referência visual externa

A proposta da outra empresa demonstra uma alternativa mais densa: cabeçalho compacto, identificação do cliente em poucas linhas e produtos organizados por ambiente com descrições técnicas agrupadas. A referência ajuda a definir densidade e hierarquia, mas não autoriza copiar logotipo, identidade visual, textos ou estrutura proprietária.

## Pontos ainda ambíguos

1. O estado de pedido será selecionado em um campo, acionado por botão ou decorrente do status aprovado?
2. A transformação cria um novo registro de pedido ou bloqueia uma versão do orçamento existente?
3. O que pode ser alterado após a confirmação: prazo, endereço, quantidade, item, custo ou fornecedor?
4. O endereço da costureira pertence ao cadastro da costureira ou ao pedido específico?
5. Número, data, fornecedor e prazo continuam no cabeçalho do pedido ao fornecedor?
6. A saída deve gerar um arquivo separado para cada fornecedor ou um arquivo com abas?
7. O custo fica oculto por padrão? Quais usuários podem revelá-lo?
8. No modo reduzido da proposta, deve existir descrição técnica resumida por ambiente?
9. No modo detalhado, valores por componente continuam opcionais?
10. Qual tamanho mínimo de fonte é aceitável para atingir a meta de compactação?
11. Quais observações são destinadas ao cliente e quais são exclusivas do instalador ou da confecção?
12. O relatório do instalador deve manter data, nome do instalador e instruções de instalação, além dos campos solicitados?

## Priorização sugerida para validação

1. Estado de pedido e congelamento dos dados.
2. Conteúdo e regra da proposta compacta.
3. Campos do pedido ao fornecedor e política de custos.
4. Conteúdo da relação do instalador.
5. Destino e visibilidade das observações.

Esta ordem organiza a conversa de produto. Ela não autoriza desenvolvimento.
