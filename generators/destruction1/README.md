# Destruction compositions 2.0

`/des1` uses ordinary Alea destruction rules: clear the orange pegs. No stage HUD, cargo passports, capture quotas, release-order gates or extra defeat conditions exist. Cargo consists only of ordinary orange/blue pegs. Existing obstacles remain structural planks, not permanent cargo balls.

The planner creates a whole level. A one/two-layer transfer motif, merge or parallel flow sits alongside towers, seesaws, cages and cradles taken directly from the existing `/des` grammar. These native assemblies keep their dimensions, group/hinge relationships and curved collision slices; only their positions and IDs change. Bowls use native curved ribbons. Magnets and explicitly paired portals use existing native mechanics. `metadata.generator.plan.flow` describes spatial design intent only; the player can dismantle any part in any order.

`npm run generate:des1` selects distinct compositions and writes the catalogue/report. It checks geometry, idle stability and actual source shots through the native normalized Game. It does not certify a full route or constrain gameplay. `npm run test:des1` checks standard objective semantics, ordinary cargo clearing, early bowl release without a penalty, deterministic generation, geometry and portal pairing. The new-construction worker runs only geometry/idle checks to keep generation short.

Main, `/gen`, `/des`, `/des1` share the same physics. Client code/assets stay on an immutable jsDelivr release in `nanohit/peggle`; Vercel serves tiny launchers. Research and the original `/des` catalogue are preserved.
