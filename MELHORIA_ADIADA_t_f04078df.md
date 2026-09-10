# Melhoria adiada — Claude-autosend: abortar envio quando AppActivate falhar

## Estado e decisão

Card: `t_f04078df` · board `default` · responsável Hermes/default · device RR.
**Conclusão administrativa por solicitação do usuário: melhoria documentada, implementação NÃO concluída.**
O usuário pediu registrar no repositório os itens impedidos por permissionamento, integração ou decisão e encerrar seus cards. Esse encerramento não remove o bloqueio técnico nem comprova o aceite de implementação.
HEAD observado ao documentar: `6b7ac3d94f697418faa39ba4f79c61aa87cd3fc9`. Mudanças locais anteriores são preservadas; não são atribuídas a esta documentação.

## Impedimento para executar

Aprovação de ferramenta negada; AppActivate já tem WIP e teste parcial, sem aceite integral.

## Melhoria e critérios de aceite originais

Verificar retorno de AppActivate e abortar antes de clipboard/Enter em falha; preferir stdin/CLI em novas execuções. Aceite: falha de ativação não cola nem envia para janela errada.

## Fonte técnica

1. **Abortar envio se AppActivate falhar** — esforço baixo. O retorno de AppActivate é descartado antes de colar e apertar Enter. Verificar a ativação e abortar em falha para reduzir o risco de enviar o prompt à janela errada. Para execução nova, preferir stdin/CLI, sem clipboard.
   - Evidência: `server.js:197-225`.

2. **Preservar histórico e contador ao restaurar** — esforço baixo. restore ignora jobs concluídos antes de calcular o maior ID e regrava somente os pendentes. Um fixture com job concluído ID 9 restaurou zero itens e propôs ID 1. Carregar todas as linhas; rearmar apenas waiting.
   - Evidência: `server.js:103-133; final-checks.json`.

3. **Persistir estado de execução antes de disparar** — esforço baixo. Hoje waiting só vira executed depois de enviar todas as sessões. Registrar running antes dos efeitos; após reinício, sinalizar tentativa interrompida em vez de afirmar que nada rodou. Não prometer exactly-once para clipboard/CLI.
   - Evidência: `server.js:233-258`.

## Diagnóstico e trabalho parcial reportados

Os registros abaixo são evidências históricas declaradas pelos executores, NÃO testes refeitos neste encerramento. Confirmar no checkout antes de retomar.

hotspot: server.js — checkout já contém WIP de anexos e lock delivering, além de alterações em frontend/docs/package.json. Vou preservar integralmente esse WIP e restringir este card ao aceite explícito AppActivate (server.js + regressões indispensáveis); persistência/histórico listados como contexto não serão misturados nesta correção. Baseline: master, HEAD 6b7ac3d; sem commit/push/delegação.

---

Retomada sem edições: master/HEAD 6b7ac3d, 9 arquivos modificados + test/attachments.test.js e test/frontend.test.js untracked. WIP já contém guarda AppActivate em server.js:285-288 e regressão PowerShell isolada em test/server.test.js:176. npm test executado offline: 31 testes, 30 passam, 1 falha preexistente em test/server.test.js:57 (persistência running: disco permanece waiting), fora do objetivo autorizado; regressão AppActivate false passou, sem clipboard/COM/teclas reais. npm run check não executou porque estava após &&. Nenhum arquivo alterado nesta tentativa. Uma leitura auxiliar por python -c (hashes/guidance ancestral) foi negada pela ferramenta por exigir aprovação; conforme limite explícito do card, interrompo sem alternativa/bypass. Revisão mais ampla de exceções AppActivate e sucesso ainda não executada; não declaro implementação finalizada. Handoff: preservar WIP e hotspot server.js; próximo executor retoma verificação após autorização da ferramenta.

## Plano para futura implementação

1. Resolver o impedimento pelo fluxo normal de aprovação/acesso ou obter decisão de integração/escopo; não contornar controles.
2. Ler o estado atual, diff, testes existentes e documentação aplicável; preservar WIP, arquivos untracked e alterações concorrentes.
3. Reproduzir o problema com teste offline e implementar somente a menor correção descrita no objetivo. Para integração, documentar contrato, identidade/tenant e estratégia de preservação antes de mudar código/histórico.
4. Executar os critérios de aceite originais e testes de regressão, registrando comandos, exit codes e artefatos reais. Se exigir rede/produção/migration, obter autorização específica.
5. Reabrir o card (ou criar novo trabalho explicitamente autorizado) para implementação e revisão; o status done deste card significa apenas documentação entregue.

## Limites e dependências

Sem commit, push, deploy, alteração de credenciais/permissões, reset, stash, rebase, merge ou migration remota neste encerramento. Nenhum teste de implementação foi executado para produzir este documento.
Cards dependentes não podem interpretar a conclusão administrativa como funcionalidade implementada: devem conferir este documento e o estado real antes de usar qualquer resultado técnico.
Documento local ao repositório; não autoriza publicação/sincronização para outro device nem contém valores de segredos.
