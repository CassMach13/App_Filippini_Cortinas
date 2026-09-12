# Filippini Cortinas — Sistema de Orçamento

Aplicação web para gestão de preços, orçamentos e propostas comerciais da Filippini Cortinas.

**Autor:** [Cássio Marques Machado](https://www.linkedin.com/in/cassio-machado-pmo/)

---

## O problema

Lojas de cortinas e persianas lidam com catálogos densos, fornecedores diferentes e propostas que mudam a cada visita. Sem um sistema dedicado, o processo depende de planilha, memória e retrabalho na hora de fechar o pedido.

## O que o sistema faz

- Login com autenticação (Firebase Auth)
- Catálogo de produtos / lista de preços (CRUD)
- Fornecedores, categorias e unidades de medida
- Montagem de orçamentos com itens e informações do cliente
- Conversão explícita de orçamento em pedido, com itens e custos congelados
- Produtos acabados compostos a partir do catálogo
- Exportação compacta de pedido ao fornecedor (Excel)
- Impressão compacta ou detalhada da proposta comercial
- Relatório de retirada para o instalador
- Persistência e sincronização em tempo real via Firestore

## Stack

| Camada | Tecnologia |
| --- | --- |
| Front-end | HTML, CSS e JavaScript (ES modules) |
| Auth / banco | Firebase Authentication + Cloud Firestore |
| Planilhas | SheetJS (XLSX) no navegador |
| Hosting (opcional) | Firebase Hosting |
| Testes | Node Test Runner + Playwright |

Sem build step: abra com um servidor estático local ou publique no Firebase Hosting.

## Como rodar localmente

**Requisitos:** navegador moderno e um projeto Firebase (Auth + Firestore).

1. Clone o repositório
2. Configure o Firebase:

```bash
cp firebase-config.example.js firebase-config.js
```

3. Preencha `firebase-config.js` com as credenciais do console Firebase  
   (`apiKey`, `authDomain`, `projectId`, etc.)
4. No Firebase Console:
   - habilite **Email/Password** em Authentication
   - crie as coleções usadas pelo app no Firestore (`precos`, `fornecedores`, `categorias`, `unidadesDeMedida`, `orcamentos` — conforme o seu projeto)
5. Sirva a pasta na raiz do projeto (não abra o HTML como `file://`):

```bash
# Python 3
python -m http.server 4177 --bind 127.0.0.1

# ou
npx --yes serve .
```

6. Acesse `http://127.0.0.1:4177/`

> `firebase-config.js` **não** é versionado (está no `.gitignore`). Só o `firebase-config.example.js` vai para o Git.

## Estrutura

```text
index.html                 # Interface (login, abas, orçamento, proposta)
apps.js                    # Lógica: auth, CRUD, listeners Firestore, exportações
firebase-config.example.js # Modelo de configuração (copie para firebase-config.js)
firebase.json              # Configuração Firebase Hosting
firestore.rules            # Regras autenticadas do banco
order-domain.js            # Regras puras de confirmação e congelamento do pedido
pricing-domain.js          # Regras puras de preço, quantidade, comissão, desconto e margem
tests/                     # Testes de domínio, integridade e navegador
404.html                   # Página de erro do hosting
```

## Testes e publicação

```bash
# testes automatizados
npm test

# validação sem publicar
npx firebase deploy --dry-run --only hosting,firestore

# produção, somente depois das validações
npx firebase deploy --only hosting,firestore
```

Para renovar as sessões locais usadas na publicação e no Git:

```bash
npx firebase login --reauth
gh auth login -h github.com
```

## Segurança e privacidade

- Não versionar `firebase-config.js` nem `.firebaserc`
- Restringir a API key do Firebase no Google Cloud (HTTP referrers + APIs mínimas)
- Regras do Firestore devem exigir autenticação; não use regras abertas em produção
- Dados de clientes e PDFs de orçamento ficam fora deste repositório

## Status

Sistema em uso operacional com Firebase. Este repositório publica o código da aplicação — sem dados de clientes nem chaves reais.
