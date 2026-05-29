# Dockerfile — à placer À LA RACINE du projet (à côté de package.json).
#
# Pourquoi un Dockerfile : il retire à Railway/Railpack toute décision sur la version
# de Node. On fige Node 22 nous-mêmes, on installe avec pnpm, on build le client, puis
# on sert le dossier dist en statique. Déterministe, plus de surprise de version.
#
# Deux étages (multi-stage) :
#   1) builder : Node 22 complet, installe tout le workspace, build le client.
#   2) runtime : image légère qui sert uniquement le dist compilé.

# ---------- étage 1 : build ----------
FROM node:22-slim AS builder

# pnpm via corepack (Node 22 le fournit, donc plus d'erreur node:sqlite).
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /app

# Copie d'abord les manifestes + lockfile pour profiter du cache Docker sur l'install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/client/package.json   packages/client/package.json
COPY packages/sim-core/package.json packages/sim-core/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json   packages/server/package.json

# Install de tout le workspace (résout les liens @metro/*).
RUN pnpm install --frozen-lockfile

# Copie le reste du code et build uniquement le client.
COPY . .
RUN pnpm --filter @metro/client build

# ---------- étage 2 : serveur statique ----------
FROM node:22-slim AS runtime

WORKDIR /app

# `serve` : petit serveur de fichiers statiques.
RUN npm install -g serve@14

# On ne récupère que le résultat du build, rien d'autre.
COPY --from=builder /app/packages/client/dist ./dist

# Railway fournit $PORT. serve écoute dessus.
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "serve -s dist -l ${PORT}"]
