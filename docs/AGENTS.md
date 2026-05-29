# AGENTS.md — Prompts Claude Code pour Metropolis.io

> **Mode d'emploi.** Chaque bloc ci-dessous est un prompt complet à coller dans une
> session Claude Code, ouverte à la racine du projet (`TEST/`). Respecte l'ordre des
> jalons. À l'intérieur d'un jalon, les prompts marqués « ‖ PARALLÈLE » peuvent
> tourner SIMULTANÉMENT dans des terminaux séparés (ils touchent des fichiers
> disjoints). Les prompts « → SÉQUENTIEL » doivent finir avant le suivant.
>
> Avant de lancer un agent : `git add -A && git commit -m "avant <prompt>"` pour
> pouvoir revenir en arrière. Après chaque agent : `pnpm -r typecheck && pnpm -r test`.

---

## JALON A — Refacto fondations

### A2 → SÉQUENTIEL (à faire EN PREMIER, tout dépend de lui)

```
CONTEXTE : Metropolis.io, clone SimCity 2000 solo en TypeScript. Monorepo pnpm,
package sim-core contient le moteur de simulation déterministe. Actuellement les
bâtiments sont décrits dans packages/sim-core/src/buildings.ts (objet STRUCTURES) et
les zones dans constants.ts (objet Zone + ZONE_CAP dans buildings.ts), mais la logique
est dispersée dans des switch (commands.ts, systems/fields.ts, render/isoRenderer.ts).

TÂCHE : Crée un registre de tuiles data-driven unique, source de vérité pour TOUS les
types plaçables (zones, réseaux, bâtiments).

1. Crée packages/sim-core/src/tiles/registry.ts avec l'interface TileDef suivante et
   un objet TILES indexé par id :
   - id: number (stable, sérialisé)
   - kind: "zone" | "net" | "building"
   - name: string
   - footprint: { w: number; h: number }
   - cost, maintenance: number
   - power: { output: number; demand: number }
   - water: { demand: number }   // mettre 0 partout pour l'instant
   - pollution, coverage: number
   - sprite: string              // clé d'atlas, mettre le nom logique ex "coal_plant"
   - unlockPop?: number
   Plus : getTile(id), tilesByCategory(cat).

2. Migre TOUTES les données existantes de STRUCTURES (buildings.ts) dans TILES sans
   changer les valeurs numériques (coûts, outputs, etc. à l'identique).

3. Garde des helpers de compat (zoneCapacity, getStructure, tileOccupancy,
   tilePowerDemand) qui lisent désormais depuis TILES, pour ne pas casser les appelants.

CONTRAINTES STRICTES :
- Ne touche à AUCUN autre fichier que tiles/registry.ts et buildings.ts.
- Les valeurs numériques restent identiques (vérifiable : les tests existants passent).
- TypeScript strict, pas de any.
- Lance `pnpm -r typecheck && pnpm -r test` à la fin, tout doit être vert.

TERMINAISON : registry.ts existe, buildings.ts réexporte depuis lui, 10 tests verts.
```

### A1 ‖ PARALLÈLE (après A2)

```
CONTEXTE : Metropolis.io, clone SC2K solo, TypeScript + PixiJS. Le rendu actuel
(packages/client/src/render/isoRenderer.ts) dessine des boîtes colorées avec l'API
Graphics de Pixi. On veut le remplacer par un rendu à base de Sprites depuis un atlas
de textures, pour accueillir de vrais sprites pixel-art plus tard. L'atlas n'existe pas
encore : pour l'instant on génère des textures de substitution (couleurs unies) par
code, mais via l'API Sprite/Texture, pas Graphics.

TÂCHE : Crée packages/client/src/render/spriteRenderer.ts qui expose EXACTEMENT la même
interface publique que IsoRenderer (init, setSnapshot, update, highlight, onHover,
onPaintTile) plus une méthode async loadAtlas(atlasUrl) qui pour l'instant peut être un
no-op si l'atlas est absent.

1. Projection iso identique (réutilise iso.ts : TILE_W=32, TILE_H=16, ALT_STEP=4).
2. Terrain : une grille de Sprites (un par tuile) avec textures générées par
   RenderTexture à partir de couleurs (placeholder), pas de Graphics par frame.
3. Surface (zones/réseaux/bâtiments) : pool de Sprites réutilisés, TRIÉS back-to-front
   par (x+y) puis par footprint — CRUCIAL pour que les bâtiments montants s'occultent
   correctement en iso.
4. Overlay heatmap et hover : peuvent rester en Graphics (couche au-dessus).
5. Le worker (simWorker.ts) ne change pas : spriteRenderer consomme les mêmes arrays.
6. Mets à jour main.ts pour instancier SpriteRenderer au lieu de IsoRenderer.

CONTRAINTES STRICTES :
- Ne touche pas à sim-core, ni au worker, ni à protocol.
- Fichiers autorisés : render/spriteRenderer.ts (nouveau), main.ts (juste le swap
  d'instanciation), éventuellement un render/textures.ts pour les placeholders.
- Garde isoRenderer.ts en place (ne le supprime pas) tant que le nouveau ne marche pas.
- Performance : réutilise les Sprites (object pool), ne recrée pas la scène chaque tick.

TERMINAISON : `pnpm --filter @metro/client dev` lance le jeu, la ville s'affiche en
sprites placeholder, pan/zoom/peinture fonctionnent comme avant.
```

### A3 → SÉQUENTIEL (après A1 ET A2)

```
CONTEXTE : Metropolis.io clone SC2K. sim-core gère un monde en Structure-of-Arrays
(packages/sim-core/src/world.ts). Tous les bâtiments sont actuellement 1x1. SC2K a des
bâtiments multi-tuiles (2x2, 3x3, 4x4 pour les centrales). Le registre TileDef
(tiles/registry.ts, créé en A2) porte déjà un champ footprint:{w,h}.

TÂCHE : Ajoute le support des footprints multi-tuiles.

1. Dans world.ts, ajoute un buffer buildingOrigin: Uint32Array(size) initialisé à
   0xFFFFFFFF (= tuile libre). Pour un bâtiment NxM posé en (ox,oy), toutes les tuiles
   du rectangle pointent vers l'index ox+oy*width.
2. Ajoute les méthodes : canPlace(x,y,footprint) (toutes tuiles in-bounds, non-eau,
   libres, MÊME altitude), stampBuilding(x,y,def), clearBuilding(x,y) (efface tout le
   footprint à partir de n'importe quelle tuile via buildingOrigin).
3. Mets à jour commands.ts (placeBuilding utilise canPlace+stampBuilding ; bulldoze
   utilise clearBuilding) et serialize.ts (ajoute buildingOrigin aux layers sauvegardés).
4. Mets à jour hashWorld pour inclure buildingOrigin.
5. Ajoute un test : poser une centrale 4x4 occupe 16 tuiles, bulldozer depuis n'importe
   laquelle libère les 16, refus si chevauchement ou altitude inégale.

CONTRAINTES STRICTES :
- Fichiers autorisés : world.ts, commands.ts, serialize.ts, et un test dans sim-core.
- Ne touche pas au renderer (un autre agent gère l'affichage des footprints).
- Déterminisme préservé : hashWorld reste cohérent, save/load round-trip exact.

TERMINAISON : tests footprint verts, tous les anciens tests verts.
```

---

## JALON B — Assets & rendu

### B1 → SÉQUENTIEL (pipeline de génération — surtout de la doc + script outil)

```
CONTEXTE : Metropolis.io clone SC2K. On veut des sprites pixel-art isométriques
cohérents pour terrain, routes, et bâtiments (zones R/C/I à plusieurs stades de densité,
centrales, services). Rendu iso diamant 2:1, tuile de base 32x16 px. Les sprites de
bâtiment s'ancrent sur le BAS du diamant et montent vers le haut.

TÂCHE : Mets en place le pipeline d'assets (pas de génération auto par toi — tu produis
les OUTILS et la doc pour que Bruno génère via ChatGPT Image / nano-banana).

1. Crée packages/client/assets/README.md décrivant :
   - La convention iso EXACTE (taille de base 32px, ancrage bas, angle 2:1, lumière
     venant du haut-gauche, palette limitée).
   - Le PROMPT-ANCRE réutilisable à coller dans le générateur d'images, qui impose
     cohérence (même angle, échelle, palette, fond transparent) — rédige ce prompt en
     anglais, prêt à l'emploi, paramétrable {BUILDING_DESCRIPTION}.
   - La liste exhaustive des sprites nécessaires (terrain x16 transitions, route x16
     connexions, R/C/I light/dense x stages 1-4/1-8, centrales, police, pompiers, parc).
   - Le format de nommage des fichiers (ex: building_res_light_s3.png).
2. Crée scripts/build-atlas.ts (Node, dépendance: aucune lourde — utilise sharp si
   besoin, sinon canvas) qui prend packages/client/assets/sprites/*.png et produit
   packages/client/public/atlas.png + atlas.json (format {frames:{name:{x,y,w,h}}}).
3. Ajoute un script npm "build:atlas" à la racine.

CONTRAINTES STRICTES :
- Tu ne génères PAS d'images toi-même. Tu fournis outils + doc + prompt-ancre.
- Le script atlas doit tourner avec `pnpm build:atlas` sans crash même si le dossier
  sprites est vide (warning propre).

TERMINAISON : README assets complet avec prompt-ancre, build-atlas.ts fonctionnel.
```

### B2 → SÉQUENTIEL (après B1, branche l'atlas dans le renderer)

```
CONTEXTE : Metropolis.io. spriteRenderer.ts (créé en A1) a une méthode loadAtlas() en
no-op. Le pipeline B1 produit public/atlas.png + atlas.json. On branche l'atlas réel.

TÂCHE :
1. Implémente loadAtlas() : charge atlas.png comme Texture Pixi, découpe en sous-textures
   selon atlas.json, expose un getFrame(name): Texture.
2. spriteRenderer utilise getFrame(tileDef.sprite) au lieu des placeholders couleur.
   Fallback : si la frame n'existe pas, garde le placeholder couleur (pour dev sans assets).
3. Charge le registre TileDef côté client (import depuis @metro/sim-core) pour mapper
   building id -> sprite name.

CONTRAINTES STRICTES : fichiers render/spriteRenderer.ts + un render/atlas.ts. Ne touche
pas à sim-core ni au worker. Le jeu doit tourner même sans atlas (placeholders).

TERMINAISON : si des sprites sont présents ils s'affichent, sinon placeholders, jeu jouable.
```

### B3 ‖ PARALLÈLE (après B2) — Terrain tilé
```
CONTEXTE : Metropolis.io, rendu iso Pixi par sprites + atlas. Le terrain s'affiche
actuellement en diamants plats colorés selon l'altitude.
TÂCHE : Améliore le rendu terrain : transitions de pente (16 cas selon les 4 coins
d'altitude voisins, comme SC2K), côtes (terre/eau), eau légèrement animée (décalage de
teinte par le tick). Utilise les frames d'atlas terrain_* si présentes, sinon shading
procédural amélioré.
CONTRAINTES : render/ uniquement (spriteRenderer.ts + éventuel render/terrain.ts). Ne
touche pas à la simulation. La projection iso reste celle d'iso.ts.
TERMINAISON : terrain visuellement riche, pas de régression de perf perceptible.
```

### B4 ‖ PARALLÈLE (après B2) — Bâtiments de zone animés
```
CONTEXTE : Metropolis.io. Les zones se développent par stages (world.stage[], 1..4 ou
1..8). Aujourd'hui un stage = une boîte plus haute.
TÂCHE : Rends la croissance LISIBLE et satisfaisante : à chaque stage, le bâtiment de
zone affiche un sprite différent (depuis l'atlas, frame building_<cat>_<dense>_s<stage>),
avec une petite animation de transition (fade/scale) quand le stage change. Marqueur
visuel discret pour brownout (pas de courant) et abandon.
CONTRAINTES : render/ uniquement. Lis stage/zone/power des arrays existants. Ne modifie
pas la simulation. L'animation ne doit pas casser le tri iso back-to-front.
TERMINAISON : voir la ville grandir est visuellement gratifiant ; perf stable.
```

---

## JALON C — Simulation complète (4 agents PARALLÈLES après B)

### C1 ‖ PARALLÈLE — Eau
```
CONTEXTE : Metropolis.io, sim-core. PowerSystem (systems/power.ts) est le modèle de
référence : flood BFS depuis les sources le long du réseau conducteur, allocation du
budget aux consommateurs. La couche souterraine existe (constants.ts: Under.Pipe), le
buffer world.water existe, TileDef porte water.demand.
TÂCHE : Crée systems/water.ts (WaterSystem implements SimPass) par analogie EXACTE avec
PowerSystem mais sur la couche Under.Pipe : pompes/châteaux d'eau = sources, pipes =
conducteurs, zones développées = consommateurs. Ajoute les bâtiments eau au registre
(pompe, château d'eau, traitement). Branche WaterSystem dans systems/index.ts
(createDefaultPasses) APRÈS power. La croissance (growth.ts) doit pénaliser les tuiles
sans eau (comme sans courant). Ajoute commande "pipe" (pose de canalisation souterraine).
CONTRAINTES : fichiers systems/water.ts, registry.ts (ajout tuiles eau), commands.ts
(commande pipe), systems/index.ts (enregistrement), growth.ts (malus eau). Déterminisme
préservé. Ajoute un test eau analogue au test power.
TERMINAISON : une ville sans eau ne grandit pas au-delà d'un seuil ; tests verts.
```

### C2 ‖ PARALLÈLE — Trafic
```
CONTEXTE : Metropolis.io, sim-core. world.traffic[] existe mais n'est jamais calculé.
growth.ts utilise seulement hasRoadNear (binaire). On veut un vrai modèle de trafic
agrégé DÉTERMINISTE (pas d'agents individuels).
TÂCHE : Crée systems/traffic.ts (TrafficSystem implements SimPass). Modèle : pour chaque
zone résidentielle développée, route un "flux" vers les zones d'emploi les plus proches
accessibles par le réseau routier (BFS/Dijkstra sur tuiles Net.Road, déterministe, ordre
d'index). Accumule la charge sur les routes traversées dans world.traffic[]. La
congestion (traffic élevé) pénalise la croissance des zones desservies (modifie growth.ts).
Optimise : limite la portée de recherche (ex. 30 tuiles) pour rester O(raisonnable) sur
petite carte.
CONTRAINTES : fichiers systems/traffic.ts, systems/index.ts (enregistrer avant growth),
growth.ts (lire la congestion). Pas de rendu. Déterministe (tout via ordre d'index, aucun
flottant non reproductible). Ajoute un test : route saturée => croissance freinée.
TERMINAISON : le trafic apparaît dans l'overlay "traffic", influe sur la ville ; tests verts.
```

### C3 ‖ PARALLÈLE — Réseau électrique enrichi
```
CONTEXTE : Metropolis.io, sim-core. PowerSystem fonctionne (coal, gas). SC2K a plus de
centrales (nucléaire, éolien, solaire, hydro, gaz, charbon, micro-ondes) avec
output/pollution/coût différents et certaines débloquées par année.
TÂCHE : Enrichis le registre avec les centrales SC2K manquantes (valeurs équilibrées,
documente la source d'inspiration). Ajoute le concept d'année de déblocage (unlockYear)
au TileDef et filtre les bâtiments disponibles selon calendar(tick).year. Pylônes :
optionnel, garde le modèle "zone conduit le courant" actuel.
CONTRAINTES : registry.ts surtout, + un helper availableBuildings(year). Ne réécris pas
PowerSystem (le flood marche). Pas de rendu. Tests : une centrale nucléaire fournit plus
qu'une charbon ; l'éolien indisponible avant son année.
TERMINAISON : catalogue de centrales complet et équilibré ; tests verts.
```

### C4 ‖ PARALLÈLE — Champs raffinés
```
CONTEXTE : Metropolis.io, sim-core, systems/fields.ts calcule pollution, couverture
police/pompier, land value, crime (déjà interdépendants avec un lag d'un tick).
TÂCHE : Raffine sans casser le déterminisme : (a) pollution diffuse mieux (poids
gaussien plutôt que box-blur uniforme), (b) la valeur foncière intègre la proximité du
centre-ville émergent (densité de population voisine) et non juste le centre
géométrique, (c) le crime augmente la nuit fiscale (baisse de revenus) — documente
l'effet. Garde tout en une seule passe single-sweep.
CONTRAINTES : systems/fields.ts uniquement (+ test). Pas d'alloc par tick (réutilise les
buffers). Déterministe. Les tests hashWorld existants peuvent changer de valeur — mets
à jour les tests d'égalité, PAS la propriété de déterminisme (même seed => même hash).
TERMINAISON : champs plus réalistes, perf stable (pas d'alloc/tick), tests verts.
```

---

## JALON D — Gestion & UI (4 agents PARALLÈLES après C)

### D1 ‖ PARALLÈLE — Budget détaillé + prêts
```
CONTEXTE : Metropolis.io. BudgetSystem (systems/budget.ts) fait un bilan mensuel simple.
La politique fiscale vit dans world.policy. Le client n'a pas encore de fenêtre budget.
TÂCHE (sim-core) : enrichis le budget — postes séparés (taxes R/C/I, maintenance par
type de service, intérêts de prêt), et un système de prêts/obligations (emprunter une
somme, remboursement mensuel sur N années avec intérêt). Stocke les prêts dans le world
(sérialisé). Ajoute commandes takeLoan/repayLoan.
TÂCHE (client) : crée ui/budgetPanel.ts (DOM) affichant les postes et permettant de
régler taxes/financements/prêts via commandes worker.
CONTRAINTES : sim-core: budget.ts, world.ts (état prêts), commands.ts, serialize.ts.
client: ui/budgetPanel.ts + branchement dans main.ts. Déterminisme préservé.
TERMINAISON : on peut emprunter, voir les postes, ajuster taxes ; faillite gérée ; tests.
```

### D2 ‖ PARALLÈLE — Ordonnances
```
CONTEXTE : Metropolis.io, SC2K a des "ordinances" (lois) activables avec coût mensuel et
effet (ex. recyclage -> moins de pollution ; promotion tourisme -> +commerce).
TÂCHE (sim-core) : modèle d'ordonnances activables (état booléen par ordonnance dans
world.policy, sérialisé), chacune avec coût mensuel et un effet appliqué dans la passe
concernée (fields/demand/budget). Implémente 6-8 ordonnances classiques.
TÂCHE (client) : ui/ordinancesPanel.ts pour cocher/décocher.
CONTRAINTES : world.ts (état), commands.ts (toggleOrdinance), les passes concernées lisent
l'état, budget.ts ajoute les coûts. client/ui/ordinancesPanel.ts. Déterministe. Tests.
TERMINAISON : activer le recyclage réduit la pollution mesurable ; tests verts.
```

### D3 ‖ PARALLÈLE — Graphes & fenêtres d'info
```
CONTEXTE : Metropolis.io. Le worker ship déjà des stats par tick (population, jobs,
funds, RCI, power...). Pas d'historique ni de graphes côté client.
TÂCHE (client uniquement) : ui/graphsPanel.ts qui bufferise l'historique des stats reçues
et trace des courbes (population, RCI, finances) — petit canvas custom ou Chart.js léger.
Plus ui/queryPanel.ts amélioré (clic sur tuile -> détail riche). Échantillonne
l'historique (ex. 1 point/mois) pour ne pas exploser la mémoire.
CONTRAINTES : client/ui/* uniquement. Lis les messages worker, n'émets pas de nouvelle
commande de simulation. Pas de modif sim-core.
TERMINAISON : fenêtres graphes + requête tuile fonctionnelles et lisibles.
```

### D4 ‖ PARALLÈLE — Récompenses & paliers
```
CONTEXTE : Metropolis.io. SC2K débloque des bâtiments spéciaux par paliers de population
(mairie ~2k, statue, banque, gratte-ciel, etc.).
TÂCHE (sim-core) : ajoute unlockPop aux TileDef concernés + une liste de récompenses
débloquées quand la population franchit un seuil (event dans stats pour que le client
notifie). availableBuildings() filtre par population ET année (cohérent avec C3).
TÂCHE (client) : notification de déblocage + filtrage de la toolbar.
CONTRAINTES : registry.ts, demand.ts (détection de seuil), client toolbar/notif.
Déterministe. Tests : franchir 2000 hab débloque la mairie.
TERMINAISON : paliers fonctionnels et notifiés ; tests verts.
```

---

## JALON E — Terrain & couches (après D)

### E1 → SÉQUENTIEL — Éditeur de terrain + relief
```
CONTEXTE : Metropolis.io. generateTerrain produit un heightfield. Pas d'édition de
terrain en jeu. SC2K permet d'élever/abaisser le sol et de gérer le niveau d'eau.
TÂCHE (sim-core) : commandes raiseTerrain/lowerTerrain/levelTerrain (coût, contraintes
de pente), recalcul des transitions eau/terre. Les bâtiments multi-tuiles exigent un sol
plat (déjà imposé par A3 canPlace). TÂCHE (client) : outils terrain dans la toolbar +
mode "éditeur" avant fondation de ville.
CONTRAINTES : world.ts (mutations altitude), commands.ts, growth/fields lisent l'altitude
si pertinent. render: affichage des pentes (cf B3). Déterministe. Tests.
TERMINAISON : on sculpte le terrain, l'eau suit, les bâtiments refusent les pentes.
```

### E2 ‖ PARALLÈLE (après E1) — Métro & rail souterrain
```
CONTEXTE : Metropolis.io. Under.Subway existe dans constants.ts, jamais utilisé.
TÂCHE : couche métro souterraine (pose de tunnels Under.Subway, stations reliant surface
et souterrain), intégrée au modèle de trafic (C2) comme capacité de transport alternative
réduisant la congestion routière. CONTRAINTES : sim-core systems/traffic.ts (intégration),
commands.ts (subway/station), registry.ts (station). client: vue souterraine basculable.
Déterministe. Tests. TERMINAISON : le métro décharge le trafic routier mesurablement.
```

### E3 ‖ PARALLÈLE (après E1) — Ponts & tunnels
```
CONTEXTE : Metropolis.io. Routes/rails ne peuvent pas franchir l'eau ni le relief.
TÂCHE : autoriser routes/rails sur l'eau (pont, surcoût) et tunnels sous relief.
CONTRAINTES : commands.ts (règles de pose pont/tunnel), render (visuel pont). sim-core
+ render. Déterministe. Tests. TERMINAISON : on relie deux rives par un pont.
```

---

## JALON F — Désastres & finitions (4 agents PARALLÈLES après E)

### F1 ‖ PARALLÈLE — Désastres
```
CONTEXTE : Metropolis.io, sim-core. Aucun désastre. SC2K : incendie (propagation
voisine), inondation, tornade (trajet aléatoire destructeur), séisme, écrasement d'avion,
monstre, fusion de centrale, émeute. Tout doit rester DÉTERMINISTE (via world.rng).
TÂCHE : systems/disasters.ts (DisasterSystem implements SimPass) en machine à états :
un désastre actif (type, position, intensité, durée) évolue chaque tick. Le feu se
propage aux tuiles voisines bâties non protégées (couverture pompier réduit la propag).
Commande triggerDisaster(type,x,y) pour le bac à sable + option d'occurrence aléatoire
selon un flag de difficulté. Les casernes (Fire) combattent le feu adjacent.
CONTRAINTES : systems/disasters.ts, systems/index.ts, commands.ts, world.ts (état
désastre courant, sérialisé). Déterministe (toute propagation/aléa via world.rng en
ordre d'index). Tests : un feu non combattu s'étend ; une caserne proche l'éteint.
TERMINAISON : déclencher un feu en bac à sable le voit se propager puis être maîtrisé.
```

### F2 ‖ PARALLÈLE — Arcologies
```
CONTEXTE : Metropolis.io. Fin de partie SC2K : 4 arcologies (Plymouth, Forest, Darco,
Launch) débloquées tard, énormes, abritant énormément d'habitants.
TÂCHE : ajoute les 4 arcologies au registre (footprint large, coût élevé, unlockYear/Pop),
chacune apportant population/jobs massifs et un effet propre. CONTRAINTES : registry.ts +
demand/budget pour leur contribution. Footprint multi-tuiles (A3). Déterministe. Tests.
TERMINAISON : poser une arcologie ajoute sa population ; déblocage tardif respecté.
```

### F3 ‖ PARALLÈLE — Journal / conseillers
```
CONTEXTE : Metropolis.io. Pas de feedback narratif. SC2K a un journal et des conseillers.
TÂCHE (client surtout) : système d'événements -> messages (le worker émet des events :
déblocage, désastre, faillite imminente, jalon de population) ; ui/newsPanel.ts affiche
un fil + conseils contextuels (ex. "Pollution élevée à l'est"). sim-core émet juste des
flags d'event dans stats. CONTRAINTES : sim-core minimal (flags d'event), client/ui/*.
TERMINAISON : les grands moments de la ville génèrent des messages lisibles.
```

### F4 ‖ PARALLÈLE — Audio
```
CONTEXTE : Metropolis.io. Aucun son. TÂCHE (client uniquement) : musique d'ambiance en
boucle (asset CC0) + SFX (pose, démolition, déblocage, désastre) déclenchés par les
events/commandes. Contrôle volume + mute. Utilise l'API Web Audio ou Howler. Documente
la source CC0 des sons dans assets/README. CONTRAINTES : client uniquement, ne bloque pas
le rendu, respecte l'autoplay policy (démarrer après 1er clic). TERMINAISON : ambiance +
retours sonores, réglables.
```

---

## Récapitulatif de l'orchestration

| Jalon | Lancer en parallèle | Attendre la fin avant |
|-------|--------------------|-----------------------|
| A | A2 seul → puis A1 → puis A3 | Jalon B |
| B | B1→B2 → puis B3 ‖ B4 | Jalon C |
| C | C1 ‖ C2 ‖ C3 ‖ C4 | Jalon D |
| D | D1 ‖ D2 ‖ D3 ‖ D4 | Jalon E |
| E | E1 → puis E2 ‖ E3 | Jalon F |
| F | F1 ‖ F2 ‖ F3 ‖ F4 | — |

Après CHAQUE agent : `pnpm -r typecheck && pnpm -r test`, puis commit. Si un agent
casse un contrat figé (TileDef, signature SimPass, message worker), on arrête, on
recadre le contrat, on relance — on ne laisse pas un agent improviser une interface.
