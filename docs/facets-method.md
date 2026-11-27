## Even facets: a low-poly mosaic

This is the **Even facets** style of the built-in Low poly step (plugin `org.ateliermesh.lowpoly` 0.3.0, code in `packages/plugins/src/facets/`). The method comes from micro-fabriek.be and is also published as the `facets` step of the Pattern shade plugin. It works on any closed model; the generator's pattern `low_poly` builds the plain shape first (a coarser grid, `detail` at least a quarter of the facet size up to 3 mm) and does the same.

1. **Remesh.** The surface is remeshed into triangles of about `facet_size` (4 to 40 mm, default 15): long edges are split (longest first), short ones collapsed, edges flipped towards six neighbours per corner, and every corner slides towards the middle of its neighbours and back onto the model. Triangles of similar size, no long strips (the report gives `edge_median_mm`, `edge_p10_mm`, `edge_p90_mm`).
   - **Sharp edges** (more than 35° between faces) and the borders between colours, bodies and plain bands stay where they are: their corners slide only along them, and only along their own edge (the outer rim never lands on the inner rim). A corner where an edge bends more than 50° does not move.
   - **Small closed edges** (a vent hole, the small top of an ornament) get at least 6 corners around, and the facets grow away from them by half the distance.
   - **Too thin for the size:** when the remeshed surface would cross itself (a 3 mm wall with 40 mm facets), that part (body) is remeshed with facets 0.75 times smaller, up to 4 times (`facet_size_mm`, `facet_size_reduced`, `parts_with_smaller_facets`).
2. **Move.** Every corner moves in or out along its normal by a random amount up to `jitter` (0 to 3 mm, default 1.2) and sideways by up to `shift` % of the facet size (default 10). `seed` picks the random numbers: the same seed gives the same facets, bit for bit.
   - **Flat faces stay flat:** a corner on a horizontal face (the base, a floor, the rim, a lid) only moves within it, so the rim and the base stay on their planes and keep their height.
   - **Plain bands:** `plain_bottom` and `plain_top` (mm, 0 = none) keep the lowest and highest part plain: the band is cut off at its height (a straight horizontal edge), remeshed, but its corners do not move.
   - **Walls (a vase, a mug):** a corner whose normal faces the axis and that has the outside of a wall behind it is on the inside. `inside = follow` (default) moves it with the outside (the move of the outside where a ray across the wall comes out), so the wall keeps its thickness; `smooth` leaves it where it was. A solid model has no inside and stays solid.
   - **Least wall:** a corner moving in keeps at least `wall` (default 1.6 mm) to the other side; the report counts `vertices_limited_by_wall`.
3. **Check.** Where an edge would pass through a triangle, a triangle would turn over, or less than `wall` would be left (measured from every corner and the middle of every facet straight into the material), the move is halved there and around it; after 6 rounds those places do not move (`vertices_held`).

**Flat facets.** Every triangle is flat, so a flat-shaded view shows each facet as one face, as in the preview.

**Colours** (`facet_colours`): `one` (default) gives one segment (`facet_1`, `colour_1`), or keeps the colours the model already had; `alternating` gives two segments, with neighbouring facets different where they can be; `random` picks each facet from a palette of `palette_size` (2 to 4) colours, avoiding its neighbours' colours. Each colour is its own segment, ready for a multicolour print. Bodies (groups) are kept with every field.

**In the generator** (`pattern = low_poly`): the collar part and the collar plate keep their own triangles; the colour of the shade is the first facet colour (`colour_2` to `colour_4` for the others, segments `shade`, `shade_2` ...). Pattern style keeps `wall` and `inside`. Vase mode: when the facets would overhang more than `max_overhang`, their move is lowered by bisection (`jitter_mm`, `jitter_reduced`). An ornament keeps its top 6 mm plain, so the small top where a hanging ring sits stays round.

The other style of the Low poly step, **Reduce** (few large facets that follow the shape), is unchanged and stays the default. Error codes: `lowpoly.not_closed`, `lowpoly.empty_input`, `lowpoly.too_many_triangles` (over 2 000 000 triangles).

