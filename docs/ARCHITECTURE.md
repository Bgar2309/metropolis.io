# ARCHITECTURE.md — Metropolis.io (cible clone SC2K solo)

## Diagramme de dépendances (cible)

```
                    packages/protocol  (schémas save/replay — Zod)
                            ▲
                            │
   ┌────────────────────────┴───────────────────────────┐
   │                  packages/sim-core                   │
   │  constants ─ tiles/registry ─ buildings ─ commands   │
   │       │            │             │          │        │
   │     world ◄────────┴─────────────┴──────────┘        │
   │       │                                              │
   │     engine ── systems/ (power water traffic fields   │
   │       │         demand growth budget disasters)      │
   │       │                                              │
   │  serialize  rng                                      │
   └───────┬──────────────────────────────────────────────┘
           │ (imported by)
   ┌───────┴───────────────────────────────────────────┐
   │                 packages/client                     │
   │  worker/simWorker  ◄── owns Engine, runs loop       │
   │       │ (postMessage: arrays + stats)               │
   │  render/  SpriteRenderer ◄ atlas ◄ assets/          │
   │  ui/      panels (budget, RCI, query, toolbar)      │
   │  game/    toolController, camera, input             │
   │  main                                               │
   └─────────────────────────────────────────────────────┘

   packages/server  ── GELÉ. Aucune évolution.
```

**Règle d'or maintenue** : `sim-core` ne connaît NI Pixi, NI le DOM, NI le réseau.
Le worker est la seule frontière entre sim (logique) et client (rendu/UI).

---

## Modules — rôle, interface publique, ce qu'ils ne font PAS

### sim-core/tiles/registry.ts  *(NOUVEAU — Jalon A2)*
**Rôle** : source unique de vérité décrivant chaque type de tuile plaçable
(zones, réseaux, bâtiments). Remplace les `switch` éparpillés.
**Interface publique** :
```ts
export interface TileDef {
  id: number;                 // identifiant stable (sérialisé)
  kind: "zone" | "net" | "building";
  name: string;
  footprint: { w: number; h: number };  // 1x1, 2x2, 3x3, 4x4
  cost: number;
  maintenance: number;
  power: { output: number; demand: number };
  water: { demand: number };             // Jalon C1
  pollution: number;
  coverage: number;                       // rayon d'effet service/amenity
  sprite: string;                         // clé d'atlas (Jalon B)
  unlockPop?: number;                     // palier de déblocage (Jalon D4)
}
export const TILES: Readonly<Record<number, TileDef>>;
export function getTile(id: number): TileDef;
export function tilesByCategory(cat: string): TileDef[];
```
**Ne fait PAS** : aucune logique de simulation, aucun rendu. Juste des données + lookups.

### sim-core/world.ts  *(MODIFIÉ — A3)*
Ajout du support footprint : un buffer `buildingOrigin: Uint32Array` indique pour
chaque tuile occupée l'index de la tuile-origine du bâtiment (0xFFFFFFFF = libre).
Ajout des buffers `water`, et plus tard couches `Under`.
**Interface ajoutée** :
```ts
canPlace(x, y, footprint): boolean;       // toutes les tuiles libres + même altitude
stampBuilding(x, y, def): void;           // pose origine + remplit occupation
clearBuilding(x, y): void;                // efface tout le footprint
```

### sim-core/systems/water.ts  *(NOUVEAU — C1)*
**Rôle** : réseau d'eau souterrain. Flood depuis pompes/châteaux d'eau le long des
`Under.Pipe`, alloue le débit aux consommateurs. Calque exact de PowerSystem.
**Interface** : `class WaterSystem implements SimPass`.
**Ne fait PAS** : ne touche pas à `power` ni au rendu. Écrit seulement `world.water[]`.

### sim-core/systems/traffic.ts  *(NOUVEAU — C2)*
**Rôle** : pathfinding agrégé résident→emploi sur le réseau routier, dépose une
charge de trafic par tuile, calcule la congestion qui pénalise la croissance.
**Interface** : `class TrafficSystem implements SimPass`.
**Ne fait PAS** : pas d'agents individuels visibles (trop coûteux) — modèle de flux
agrégé déterministe. Écrit `world.traffic[]`.

### sim-core/systems/disasters.ts  *(NOUVEAU — F1)*
**Rôle** : machine à états de désastres (feu qui se propage de tuile en tuile, etc.).
Piloté par commandes (`triggerDisaster`) ou RNG selon un flag.
**Interface** : `class DisasterSystem implements SimPass` + commandes associées.

### client/render/spriteRenderer.ts  *(REMPLACE isoRenderer — A1)*
**Rôle** : rendu Pixi à base de `Sprite` depuis un atlas, plus de `Graphics` boîtes.
Layers : terrain (TileSprites) → réseaux → bâtiments (triés en Y pour l'ordre iso) →
overlay heatmap → hover.
**Interface publique** (compatible worker existant) :
```ts
async init(host): Promise<void>;
async loadAtlas(atlasUrl): Promise<void>;   // NOUVEAU
setSnapshot(width, height, terrain, altitude): void;
update(zone, stage, net, building, power, overlay, overlayField): void;
highlight(tx, ty): void;
onHover, onPaintTile callbacks;
```
**Ne fait PAS** : aucun state de simulation, aucun calcul de gameplay. Peint les
arrays. Le tri iso (back-to-front par x+y) est obligatoire avec des sprites montants.

### client/game/toolController.ts  *(NOUVEAU — extraction depuis main.ts)*
**Rôle** : état de l'outil actif (zone R/C/I, route, ligne, bulldozer, bâtiment X),
traduit un clic-tuile en `Command` envoyée au worker. Gère le drag (route en ligne).
**Ne fait PAS** : ne dessine rien, ne simule rien.

### client/ui/*  *(NOUVEAU — Jalon D)*
Panneaux : `toolbar.ts`, `budgetPanel.ts`, `rciPanel.ts`, `queryPanel.ts`,
`graphsPanel.ts`. DOM/HTML pur ou petite lib, pas de framework lourd imposé.
Chaque panneau lit les stats du worker et émet des commandes.

---

## Ordre de construction & points de parallélisation

```
JALON A (séquentiel partiel) :
  A2 (registry) ─┐
                 ├─► A1 (sprite renderer) ─► A3 (footprints)
  A2 d'abord ────┘   (A1 et A3 dépendent du registry)

JALON B (après A) :
  B1 (pipeline sprites) ─► B2 (atlas) ─► [B3 terrain ‖ B4 bâtiments]  (B3,B4 parallèles)

JALON C (après B) :  C1 ‖ C2 ‖ C3 ‖ C4   (4 agents parallèles, modules disjoints)

JALON D (après C) :  D1 ‖ D2 ‖ D3 ‖ D4   (parallèles, UI disjointe)

JALON E (après D) :  E1 ─► [E2 ‖ E3]

JALON F (après E) :  F1 ‖ F2 ‖ F3 ‖ F4   (parallèles)
```

**Contrats figés avant dev parallèle** : `TileDef`, signatures `SimPass`, format de
message worker↔renderer, format d'atlas JSON. Une fois écrits, on n'y touche plus
pendant qu'un groupe d'agents tourne — sinon ils se contredisent.

---

## Contraintes Bruno-spécifiques à respecter

- **TypeScript strict** partout (le projet l'est déjà — `noUncheckedIndexedAccess`).
- **Pas de framework UI lourd** imposé : rester en TS/DOM ou Pixi pour l'UI in-game.
  (Pas de React ici — l'app est canvas-first, React alourdirait pour rien.)
- **Déterminisme préservé** : toute nouvelle passe lit/écrit le world via buffers,
  tout aléa passe par `world.rng`. Les tests `hashWorld` doivent rester verts.
- **Footprint = altitude unique** : un bâtiment multi-tuiles exige que toutes ses
  tuiles soient à la même altitude (comme SC2K). Sinon refus de pose.
- **Aucune dépendance interdite** : pas de pandas-ta/ta-lib (non pertinent ici, mais
  pour mémoire : pur TS, deps minimales).
