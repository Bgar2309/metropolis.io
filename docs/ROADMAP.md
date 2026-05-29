# Metropolis.io — Roadmap vers un clone SimCity 2000 (solo, hors-ligne)

> Objectif : transformer le moteur actuel (excellent socle Phase 0/1) en un clone
> SimCity 2000 jouable en solo, sur petite carte, pour le plaisir. Pas de online,
> pas de serveur, pas de ranked. Le code serveur (`packages/server`) est gelé : on
> n'y touche plus. Le déterminisme/action-log est conservé (gratuit, utile au
> save/load + debug) mais n'est plus un objectif en soi.

## Priorités (dans l'ordre de TON plaisir)

1. **Voir la ville grandir visuellement** → c'est le fil rouge. Chaque jalon doit
   rendre la ville plus vivante à l'écran. C'est pour ça que la passe ART vient tôt.
2. **Défi budgétaire & gestion** → budget riche, prêts, graphes, ordonnances.
3. **Simulation réaliste enchaînée** → trafic réel, pollution, criminalité, valeur.
4. **Bac à sable** → mode sans contrainte d'argent + désastres déclenchables.

---

## Les 6 jalons (milestones)

Chaque jalon est un état jouable cohérent. Tu peux t'arrêter à n'importe lequel et
avoir un jeu qui tourne. Les jalons sont séquentiels ; à l'intérieur, plusieurs
agents tournent en parallèle (voir AGENTS.md).

### Jalon A — Refacto fondations (AVANT tout le reste)
Le code actuel est propre mais a 3 dettes qui bloqueraient la suite. À régler d'abord.
- A1. Découpler le rendu : passer de `Graphics` (boîtes) à un **SpriteRenderer** à
  base d'atlas de textures, prêt à recevoir les vrais sprites. C'est LE changement
  structurant : sans lui, pas d'art SC2K.
- A2. **Registre de tuiles data-driven** : aujourd'hui les bâtiments sont des `switch`
  éparpillés (commands, fields, renderer). On centralise tout dans un `TileRegistry`
  (taille footprint, sprite, coût, effets) pour pouvoir ajouter 50 bâtiments sans
  toucher 6 fichiers.
- A3. **Footprints multi-tuiles** : SC2K a des bâtiments 1x1, 2x2, 3x3, 4x4. Le moteur
  actuel est tout en 1x1. On ajoute le support footprint (origine + occupation).

### Jalon B — Pipeline d'assets graphiques (la ville devient belle)
- B1. **Pipeline de génération de sprites** cohérents (script + prompt-ancre réutilisable).
- B2. **Atlas builder** : assembler les PNG en spritesheet + JSON d'atlas chargé par Pixi.
- B3. **Terrain tilé** : 16 transitions de pente + côtes, eau animée.
- B4. **Bâtiments de zone animés** : sprite par catégorie × densité × stage (la
  ville pousse visuellement).

### Jalon C — Simulation complète SC2K
- C1. **Eau** (réseau de canalisations souterrain + pompes + château d'eau + besoin en eau).
- C2. **Trafic réel** (pathfinding résident→travail, congestion, effet sur croissance).
- C3. **Réseau électrique enrichi** (lignes, pylônes, plus de types de centrales).
- C4. **Land value / pollution / criminalité** raffinés et interdépendants (déjà ébauché).

### Jalon D — Gestion & économie profonde
- D1. **Budget détaillé** : postes de dépense, slider de financement par service, prêts/obligations.
- D2. **Ordonnances** (ordinances) : lois activables avec coût/effet (ex. recyclage, couvre-feu).
- D3. **Graphes & fenêtres d'info** : population, RCI, finances dans le temps.
- D4. **Récompenses & paliers** (mairie, statue, gratte-ciel) débloqués par population.

### Jalon E — Terrain & couches avancées
- E1. **Éditeur de terrain** + relief jouable (élévation, abaissement, niveau d'eau).
- E2. **Métro & rail souterrain** (couche `Under.Subway`, stations).
- E3. **Ponts & tunnels** sur l'eau et le relief.

### Jalon F — Le sel SC2K
- F1. **Désastres** : incendie (propagation), inondation, tornade, tremblement de terre,
  monstre, accident de centrale. Déclenchables (bac à sable) ou aléatoires.
- F2. **Arcologies** (les 4 types, fin de partie).
- F3. **Journal / conseillers** : événements narratifs, conseils contextuels.
- F4. **Audio** : musique d'ambiance + SFX (place, démolition, désastre).

---

## Ordre recommandé & estimation

| Jalon | Contenu | Agents | Effort |
|-------|---------|--------|--------|
| A | Refacto fondations | 1 séquentiel + 2 parallèles | ~1-2 jours |
| B | Assets & rendu | 1 pipeline + 3 parallèles | ~2-3 jours |
| C | Simulation | 4 parallèles | ~3-4 jours |
| D | Gestion | 4 parallèles | ~2-3 jours |
| E | Terrain/couches | 3 parallèles | ~2-3 jours |
| F | Désastres & finitions | 4 parallèles | ~3-4 jours |

**Total indicatif : 2-3 semaines de travail en soirées.** Tu peux livrer un jeu
« satisfaisant à regarder grandir » dès la fin du Jalon B.

---

## Sur les assets graphiques — décision

**Sprites originaux Maxis** : disponibles (Spriters Resource, etc.) mais propriété
EA/Maxis → OK pour prototyper en local, JAMAIS sur ton dépôt public. On les évite.

**Recommandation : génération IA en planches cohérentes + complément CC0.**
- Base de secours **CC0** (zéro contrainte légale) : assets isométriques de Kenney
  sur opengameart.org / kenney.nl. Parfait pour terrain, routes, props.
- **Génération** (ChatGPT Image / nano-banana) pour les bâtiments : le piège est la
  COHÉRENCE. Règle d'or → générer par PLANCHE (sprite sheet) avec un prompt-ancre
  fixe imposant : même angle iso 2:1, même échelle pixel, même palette, fond
  transparent, même direction de lumière. Voir B1 dans AGENTS.md pour le prompt-ancre.

**Contrainte technique iso** : ton moteur est en diamant 2:1, `TILE_W=32`, `TILE_H=16`.
Les sprites de bâtiment montent au-dessus de la base. Convention à figer dès B1 :
base de sprite = 32px large, ancrée sur le bas du diamant, hauteur libre vers le haut.

---

## Ce qu'on NE fait PAS (hors scope, assumé)

- Pas de multijoueur, pas de cloud save, pas de classement.
- Pas de vérification serveur (le code existe, on le laisse dormir).
- Pas de portage mobile/tactile (souris + clavier desktop only).
- Pas de mod support / éditeur de scénario (peut venir après F si l'envie est là).
