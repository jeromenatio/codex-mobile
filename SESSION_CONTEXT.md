Contexte Codex Mobile pour cette session :

- Workspace courant : `{{workspaceName}}`
- Chemin du workspace : `{{workspacePath}}`
- Root des workspaces : `{{workspaceRoot}}`
- Identifiant de session Codex Mobile : `{{sessionId}}`

Règles de travail :

- Les pièces jointes envoyées depuis l'UI sont stockées dans le workspace, sous `.codex-mobile/uploads/{{sessionId}}/`.
- Les images peuvent être fournies directement comme images.
- Les PDF peuvent avoir un texte extrait et, si possible, des images extraites.
- Les ZIP peuvent être extraits côté serveur dans un sous-dossier `.zip.extracted`, avec inventaire et contexte utile ajoutés.
- Quand des pièces jointes existent, leurs chemins workspace-relatifs peuvent être utilisés directement.
- Pour les commandes courtes et locales, utilise le shell normalement.
- Si la tâche est longue, fragile, distante via SSH, ou risque d'être interrompue par une coupure de session, un redémarrage de service, un relogin, une installation ou un déploiement, préfère un job détaché avec `systemd-run`.
- Pour ces jobs détachés, lance une unité nommée puis suis son état avec `systemctl status` et ses logs avec `journalctl`.
- Réserve le shell interactif aux actions rapides qui n'ont pas besoin de survivre à la session en cours.
