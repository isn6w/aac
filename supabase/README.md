# Supabase: catálogo e estoque inicial

1. As variáveis locais já foram gravadas em `.env.local` (arquivo ignorado pelo
   Git). Configure os mesmos nomes no ambiente de produção da Vercel. Nunca use
   uma chave `service_role` no navegador.
2. Em um projeto Supabase novo, aplique
   `migrations/20261006194500_catalog_and_inventory.sql` pelo SQL Editor.
3. Os usuários que já existem e os novos recebem um perfil `cashier`
   intencionalmente. Crie o primeiro usuário em Supabase Auth e promova a conta
   administradora com o `INSERT ... ON CONFLICT` de diagnóstico abaixo. Ele
   também cria o perfil caso o gatilho não tenha criado uma linha.

4. Desative o cadastro público de usuários no Supabase Auth. Convide os demais
   usuários e atribua a função apropriada pelo administrador.

Se o login funcionar, mas a calculadora informar acesso restrito, autenticação
não é o mesmo que a função administrativa da aplicação. Confira a linha do
usuário no SQL Editor e promova exatamente a conta desejada:

```sql
select u.email, u.id, p.role
from auth.users u
left join public.profiles p on p.user_id = u.id
where lower(trim(u.email)) = lower(trim('<EMAIL_DO_ADMIN>'));

insert into public.profiles (user_id, role)
select id, 'admin'
from auth.users
where lower(trim(email)) = lower(trim('<EMAIL_DO_ADMIN>'))
on conflict (user_id) do update set role = 'admin';
```

Confirme que o `SELECT` retorna `admin` e que a consulta encontrou exatamente
uma conta; depois use “Verificar permissões novamente” na calculadora ou entre
novamente.

5. Para habilitar a calculadora markup, aplique
   `migrations/20261007170000_product_markup_pricing.sql` pelo SQL Editor após
   a migration inicial. Ela adiciona uma tabela de custos com leitura restrita
   a admin/gerente, histórico de cálculos e a função autorizada que recalcula e
   salva custo e preço de forma atômica.

O primeiro escopo usa um estoque único. O código interno e o código de barras
são únicos sem diferenciar maiúsculas/minúsculas; códigos de barras são texto
para preservar zeros à esquerda. Preços são armazenados em centavos e o saldo
suporta até três casas decimais para itens pesáveis. Entradas e retiradas são
registradas pela função atômica `record_stock_movement`; saldo não pode ficar
negativo.

A calculadora usa markup divisor:
`preço = custo unitário ÷ [1 - (taxas variáveis + rateio fixo + tributos + lucro desejado)]`.
Taxas variáveis e tributos são percentuais do preço de venda. Antes da migration
`20261010173000_fixed_expenses_as_percentages.sql`, custos fixos eram convertidos
em taxa pela previsão mensal; após ela, despesas fixas são informadas diretamente
como percentuais sobre o preço de venda.
A soma deve ser inferior a 100%. A alíquota tributária é apenas uma estimativa
fornecida pelo operador, não orientação fiscal. Cada preço salvo registra os
valores usados em `product_pricing_history`; somente admin/gerente pode
consultar o histórico ou salvar um novo preço.

6. Para habilitar taxas e despesas personalizadas, aplique
   `migrations/20261008120000_pricing_settings.sql` depois das duas migrations
   anteriores. Essa migration inicial armazenava despesas fixas em reais e
   usava previsão de faturamento para estimar o percentual.

Se a calculadora mostrar `PGRST205`, confirme que as migrations
`20261007170000_product_markup_pricing.sql` e
`20261008120000_pricing_settings.sql` foram executadas na ordem indicada no
SQL Editor. Esse código significa que a API do Supabase não encontrou uma
tabela no schema publicado; após aplicar a migration, atualize a página. A
migration de configurações solicita também a atualização do cache do PostgREST.

7. Para preço desejado, validades por lote e entrada de notas, aplique
   `migrations/20261010150000_pricing_invoice_batches.sql` após as migrations
   anteriores. A calculadora agrega todas as taxas variáveis ativas (incluindo
   tributos cadastrados como taxa variável) e todas as despesas fixas ativas;
   esses totais são somente leitura. O modo “Preço desejado” calcula o lucro e
   o banco rejeita preços inferiores ao piso de custo mais despesas, sem lucro.

   Entradas de estoque e notas são transacionais e registram lotes com validade
   quando informada. Saldos já existentes no momento da migration são
   convertidos em lotes de abertura sem validade conhecida, para que as saídas
   posteriores também mantenham o saldo dos lotes consistente. A exportação XML
   do módulo de notas é um arquivo operacional do A.A.C., não uma NF-e, XML
   fiscal oficial ou transmissão à SEFAZ.

8. Para informar cada despesa fixa diretamente como percentual e incluí-la no
   markup, aplique `migrations/20261010173000_fixed_expenses_as_percentages.sql`
   depois das migrations anteriores. Ela converte despesas existentes usando
   a previsão mensal configurada; se não havia previsão, contas não zeradas são
   migradas para 100% como alerta de revisão, evitando que sejam ignoradas no
   cálculo. Edite esses percentuais em Configurações antes de salvar preços.
   Depois, despesas fixas e variáveis ativas são somadas diretamente como taxas
   sobre o preço de venda; não é mais necessário configurar previsão mensal.
   O lucro do modo “Preço desejado” é exibido automaticamente pela fórmula
   divisor, incluindo margem negativa quando o preço estiver abaixo do piso.

9. Para habilitar o PDV e a confirmação de preços markup na importação de XML,
   aplique `migrations/20261010190000_sales_and_markup_invoice_import.sql`
   depois de todas as migrations anteriores. O PDV grava a venda, os itens,
   recebimento, troco, saída de estoque e movimentação em uma única RPC
   transacional; leitores de código de barras USB que enviam Enter são
   suportados. Admins, gerentes e caixas podem finalizar vendas; permissões e
   saldo são validados novamente no banco. Somente admins e gerentes podem
   alterar preço unitário ou aplicar descontos; caixas usam o preço cadastrado.

   A prévia do XML mostra os dados disponíveis no arquivo (fornecedor, endereço,
   telefone, produtos, quantidades, custos e campos tributários) antes de
   preencher o formulário. A aplicação de preço é opcional: usa as taxas ativas
   em Configurações e a meta de lucro informada, atualizando custo e preço no
   mesmo registro transacional da nota. A importação apenas exibe os campos
   fiscais presentes no XML; não autoriza documentos nem transmite dados à
   SEFAZ.

10. **Execute a migration-base de vendas antes da migration de parcelas.** No
    SQL Editor, abra e execute o arquivo completo
    `migrations/20261010190000_sales_and_markup_invoice_import.sql` e confirme
    que terminou sem erros. Ela cria `public.sales`, `public.sale_items` e a
    função-base `record_sale`. Só depois aplique
    `migrations/20261010193500_sale_installments.sql` para salvar o número de
    parcelas no pagamento com cartão de crédito (1 a 12).
    Para conferir se a migration-base terminou, execute
    `select to_regclass('public.sales') as sales_table,
    to_regclass('public.sale_items') as sale_items_table,
    to_regprocedure('public.record_sale(jsonb,text,integer)') as record_sale;`.
    Os três resultados devem ser diferentes de `NULL`. Se executar a migration
    de parcelas primeiro, ela interromperá com uma mensagem informando a
    dependência da migration-base.

    O valor exibido por parcela é uma estimativa sem taxas da operadora; confirme
    as condições efetivas na maquininha antes de autorizar.

11. Aplique `migrations/20261010195000_pix_payment_settings.sql` para habilitar
    as configurações Pix adicionais. Cadastre a chave, nome e cidade do
    recebedor na página Configurações. O modo manual gera um BR Code local e
    exige confirmação manual no PDV.

    Para Mercado Pago, selecione esse modo nas configurações e configure
    `MP_ACCESS_TOKEN` como variável privada no servidor local/deploy; nunca use
    `NEXT_PUBLIC_` nem salve o token na tabela de configurações. O checkout pede
    o e-mail do pagador, gera o QR pela API e consulta o status diretamente no
    Mercado Pago; a venda e a baixa de estoque só ocorrem após status aprovado.
    Mantenha a tela do checkout aberta até a confirmação e o registro da venda;
    a consulta de status é executada enquanto o PDV está aberto.
    Se o pagamento for aprovado, mas a transação do estoque/venda falhar, o PDV
    alerta para não cobrar novamente; a conciliação ou o eventual estorno deve
    ser feito manualmente na conta Mercado Pago.
    O QR da API é creditado na conta associada ao token Mercado Pago; confira
    antes se essa conta corresponde à chave Pix informada. A chave Pix define o
    recebedor do modo manual, mas a API do Mercado Pago não permite escolher
    outra chave como destino do pagamento.

    **Erro `42P01: relation "public.sales" does not exist`:** a migration de
    parcelas foi executada antes da criação das vendas. Execute primeiro
    `20261010190000_sales_and_markup_invoice_import.sql`; depois,
    `20261010193500_sale_installments.sql`; por último,
    `20261010195000_pix_payment_settings.sql`. A migration de parcelas depende
    da tabela `public.sales` criada pela migration-base de vendas.

12. Para habilitar o assistente financeiro, aplique
   `migrations/20261013120000_invoice_payables.sql` depois das migrations de
   notas e estoque. Ela cria um título de contas a pagar na mesma transação de
   cada nota registrada, inicialmente com vencimento em 30 dias; notas já
   existentes também recebem um título. Admins e gerentes podem ajustar
   vencimento, impostos e referência/linha digitável, além de marcar ou reabrir
   pagamentos. O valor do título acompanha o total da nota; impostos ficam
   como “não informado” até que o operador os preencha. A aplicação não gera
   nem liquida boletos bancários.

   Os alertas locais destacam títulos vencidos e os que vencem em até 7 dias.
   Para solicitar uma síntese por IA e usar o chat do espaço de trabalho,
   configure `GEMINI_API_KEY` como variável privada do servidor e,
   opcionalmente, `GEMINI_MODEL` (padrão `gemini-3.8-flash`) em `.env.local` e
   na Vercel. Nunca use prefixo `NEXT_PUBLIC_` para a chave. Reinicie o servidor
   local após alterar o ambiente. A análise financeira envia fornecedor, número da nota, vencimento,
   valor e imposto ao provedor de IA somente após o operador clicar em
   “Analisar com IA”; sem a chave, os alertas por vencimento continuam ativos.
   O chat usa o cliente Supabase da sessão autenticada e, conforme o assunto,
   lê somente catálogo ativo ou notas/títulos financeiros pelas permissões RLS;
   não envia linha digitável, não executa SQL gerado pela IA e nunca grava dados.
   Esses trechos consultados são enviados ao Gemini junto da pergunta. A conversa
   é temporária no navegador.
