# Codex Mobile

Interface mobile-first pour créer des sessions Codex, les lier à des workspaces, et discuter avec Codex depuis le navigateur.

## Prérequis

Ubuntu 22.04+ recommandé.

## Installation Ubuntu

```bash
sudo apt update
sudo apt install -y git curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
git --version
node -v
npm -v
```

## Installation de Codex CLI

Commande officielle OpenAI :

```bash
npm install -g @openai/codex
codex --version
codex login
```

Source :
- https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started

Connexion requise :
- connecte-toi avec `codex login` avant de lancer l'application

## Cloner le repo

```bash
git clone https://github.com/jeromenatio/codex-mobile.git
cd codex-mobile
```

## Installer les dépendances

```bash
npm install
```

## Lancer le projet

```bash
npm start
```

L'application écoute par défaut sur :

```text
http://127.0.0.1:4180
```

## Notes

- Par défaut, les workspaces sont créés sous `/projects`.
- Le dossier racine des workspaces est modifiable depuis l'interface, dans `Configuration`.
- Les sessions et l'état local sont persistés côté serveur.
- Codex CLI doit être installé et configuré sur la machine pour que les sessions Codex fonctionnent.
