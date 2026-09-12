# Plano de correções de usabilidade

Data: 12/09/2026

## Objetivo

Corrigir os riscos encontrados na auditoria de usabilidade sem alterar as regras comerciais já aprovadas e sem publicar em produção antes do teste local do responsável pelo projeto.

## Etapa 1 — Integridade de cálculos e cadastros — concluída

- Normalizar as variações de unidades de medida usadas pelo sistema.
- Garantir que “Metro Linear” e “MetroLinear” tenham o mesmo comportamento.
- Garantir que “Metro Quadrado” e “MetroQuadrado” tenham o mesmo comportamento.
- Rejeitar preço de compra, markup, quantidade e medidas inválidas.
- Cobrir as regras com testes unitários.

Critério de aceite: nenhuma variação conhecida de unidade pode cair silenciosamente no cálculo por unidade, e valores financeiros não positivos devem ser rejeitados.

## Etapa 2 — Confiabilidade do salvamento — concluída

- Fazer a rotina de salvamento informar sucesso ou falha aos chamadores.
- Não fechar formulários nem informar sucesso quando o Firebase rejeitar a gravação.
- Restaurar o último estado persistido quando uma gravação falhar.
- Exibir estados “alterações não salvas”, “salvando” e “salvo”.
- Avisar ao sair da página quando houver alterações pendentes.

Critério de aceite: a interface nunca pode declarar sucesso depois de uma falha de persistência.

## Etapa 3 — Fluxo e responsividade — concluída

- Desabilitar ações incompatíveis com o estado orçamento/pedido.
- Reposicionar a configuração do relatório de fornecedor junto à sua ação.
- Corrigir a estrutura da tabela de itens.
- Corrigir o indicador de ordenação e a busca acionada por colagem/limpeza.
- Adaptar cabeçalho, abas, formulários e ações para telas menores.
- Substituir alertas informativos por notificações não bloqueantes.

Critério de aceite: ações indisponíveis devem ser evidentes antes do clique, e a interface deve permanecer operável em desktop e celular.

## Etapa 4 — Teclado e acessibilidade — concluída

- Transformar o login em formulário com envio por Enter e estado de carregamento.
- Tornar abas operáveis por teclado e expor corretamente a aba ativa.
- Tornar modais semânticos, prender o foco e permitir fechamento por Escape.
- Tornar a busca inteligente operável por setas, Enter e Escape.
- Tornar a ordenação da tabela acessível pelo teclado.
- Adicionar regiões acessíveis para mensagens assíncronas.

Critério de aceite: os fluxos principais devem ser executáveis somente com teclado e sem controles interativos baseados em `div` ou `span`.

## Validação

- Testes unitários das regras financeiras e de unidades.
- Testes estáticos de integridade HTML e acessibilidade estrutural.
- Verificação de sintaxe dos módulos JavaScript.
- Smoke test no navegador em viewport desktop e móvel.
- Teste local manual antes de qualquer publicação.

## Resultado automatizado

- 26 testes unitários e estáticos aprovados.
- Sintaxe dos módulos JavaScript aprovada.
- Pacote de Firebase Hosting gerado com 7 arquivos.
- Smoke test aprovado sobre o pacote final em desktop e celular.
- Fluxos verificados: login por Enter, mensagens de validação, navegação de abas por teclado, foco e Escape nos modais, busca inteligente, ordenação e ausência de rolagem horizontal da página móvel.

## Registro da publicação em produção

- Deploy realizado em 12/09/2026 no Firebase Hosting.
- Versão publicada: `aae1ab2c2c0b1855a1d072108b92d5ce6cca303f`.
- Integração realizada pelo PR #1.
- Entrega contemplada: correções de cálculo, duplicação de orçamento, validade da cópia e responsividade da proposta detalhada.
- 26/26 testes automatizados aprovados.
- Teste E2E aprovado.
- Smoke test de produção aprovado, incluindo cálculo, salvamento, duplicação, validade, responsividade, relatórios, congelamento e persistência.
- Registros fictícios `ORC-11` e `ORC-12`, usados exclusivamente no smoke test, removidos após a validação.
- Branch `codex/estabilizacao-calculos` removida localmente e do remoto após a integração.
- O problema local de instalação/caminho do `npm` permanece registrado como questão de ambiente e não afetou esta entrega.
