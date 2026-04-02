# Codex Mobile

Interface mobile-first pour créer des sessions Codex, les lier à des workspaces, et discuter avec Codex depuis le navigateur.

## Installation rapide

Commande recommandée sur Ubuntu :

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/jeromenatio/codex-mobile/main/install.sh)
```

Version détachée via `systemd-run` pour les installs distantes fragiles :

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/jeromenatio/codex-mobile/main/install-detached.sh)
```

Le script :
- installe `git`, `curl`, `node`, `npm` et `codex` si besoin
- installe aussi `openssl` pour générer le token d'accès
- installe aussi `build-essential` et `python3` pour les dépendances natives Node
- installe `poppler-utils` pour l'extraction d'images PDF
- clone ou met à jour le repo dans `/projects/codex-mobile`
- lance `npm install`
- demande si tu gardes le root workspace par défaut `/projects`
- crée `/etc/codex-mobile/.env`
- génère un token `CODEX_MOBILE_AUTH_TOKEN`
- garde une place pour `GITHUB_TOKEN`
- lance `codex login` si Codex n'est pas déjà connecté
- peut installer et démarrer les services systemd `codex-mobile` et `codex-mobile-runtime`

Le wrapper `install-detached.sh` :
- lance l'installation dans une unité `systemd` indépendante
- évite qu'une coupure SSH interrompe le script
- permet de relire le code `codex login` dans `journalctl`

Le contexte initial de session est défini dans :

```text
SESSION_CONTEXT.md
```

Il est injecté une seule fois au premier tour d'une session pour expliquer à Codex :
- comment sont gérées les pièces jointes
- où elles sont stockées dans le workspace
- comment utiliser les secrets déjà disponibles dans `/etc/codex-mobile/.env`
- quand préférer `systemd-run` pour les tâches longues, fragiles, ou nécessitant une intervention utilisateur en cours de route
- comment structurer une reprise possible après attente, login, validation ou erreur transitoire

## Après installation

Si tu n'as pas choisi l'installation du service systemd :

```bash
cd /projects/codex-mobile
npm start
```

En lancement manuel, `server.js` démarre aussi le runtime local si besoin.

L'application écoute par défaut sur :

```text
http://127.0.0.1:4180
```

Au premier accès web, l'interface demande le token contenu dans :

```bash
sudo sed -n 's/^CODEX_MOBILE_AUTH_TOKEN=//p' /etc/codex-mobile/.env
```

## Lancer comme service systemd

Depuis le dossier `codex-mobile` :

```bash
chmod +x service.sh
sudo ./service.sh
```

Le script :
- installe les services `codex-mobile` et `codex-mobile-runtime`
- démarre les deux immédiatement
- active les deux au démarrage du serveur
- redémarre automatiquement les deux en cas de crash ou de reboot

## Installation manuelle

Si tu préfères faire l'installation étape par étape :

```bash
sudo apt update
sudo apt install -y git curl ca-certificates gnupg openssl poppler-utils build-essential python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g @openai/codex
codex login
git clone https://github.com/jeromenatio/codex-mobile.git /projects/codex-mobile
cd /projects/codex-mobile
npm install
npm start
```

## Notes

- Par défaut, les workspaces sont créés sous `/projects`.
- Le dossier racine des workspaces est modifiable pendant l'installation puis dans `Configuration`.
- Le fichier `/etc/codex-mobile/.env` est préparé pour le token d'accès et un futur `GITHUB_TOKEN`.
- L'API et le WebSocket sont protégés par session cookie quand `CODEX_MOBILE_AUTH_TOKEN` est présent.
- La liste des modèles affichée dans l'interface est rafraîchie en live via Codex quand la configuration est chargée.
- Les sessions et l'état local sont persistés côté serveur.
- En mode service, l'exécution des tours Codex est portée par `codex-mobile-runtime`, séparé du serveur web `codex-mobile`.
- Codex CLI doit être installé et connecté sur la machine pour que les sessions Codex fonctionnent.

## Contexte de Session

Le fichier [SESSION_CONTEXT.md](./SESSION_CONTEXT.md) est là pour rendre Codex plus fiable sur les tâches réelles du projet. Il doit surtout aider Codex à :

- utiliser correctement les pièces jointes stockées dans le workspace, y compris les textes, images et dossiers extraits
- vérifier qu'une pièce jointe existe encore avant de s'y appuyer
- réutiliser les secrets déjà présents dans `/etc/codex-mobile/.env` avant de demander une ressaisie
- préférer une tâche détachée via `systemd-run` si le travail est long, fragile, distant ou interrompable
- préférer une tâche détachée si une intervention utilisateur sera probablement nécessaire en cours de tâche
- laisser des informations de reprise claires pour suivre ou reprendre un job détaché
- éviter d'abandonner trop vite sur une erreur transitoire d'API, de réseau ou de Codex

En pratique, si tu modifies `SESSION_CONTEXT.md`, vise des règles concrètes, courtes et prescriptives. Il est plus utile d'écrire :

- quoi vérifier
- quand passer en tâche détachée
- où chercher les secrets et pièces jointes
- comment reprendre après interruption

qu'un texte générique ou purement descriptif.
