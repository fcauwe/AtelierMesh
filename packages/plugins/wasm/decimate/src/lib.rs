// Mesh decimation by edge collapse with quadric error metrics (Garland and Heckbert 1997): the same algorithm as src/decimate.ts,
// written for WebAssembly. No dependencies, a plain C interface over linear memory (no wasm-bindgen).
// The caller copies the mesh in with alloc(), calls decimate(), and reads the result through the out_* functions.
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default)]
struct Fx(u64);
impl Hasher for Fx {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) { for b in bytes { self.0 = (self.0.rotate_left(5) ^ *b as u64).wrapping_mul(0x517cc1b727220a95); } }
    fn write_u64(&mut self, v: u64) { self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x517cc1b727220a95); }
}
type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;

type Q = [f64; 10];

fn add_plane(q: &mut Q, a: f64, b: f64, c: f64, d: f64, w: f64) {
    q[0] += w * a * a; q[1] += w * a * b; q[2] += w * a * c; q[3] += w * a * d;
    q[4] += w * b * b; q[5] += w * b * c; q[6] += w * b * d;
    q[7] += w * c * c; q[8] += w * c * d; q[9] += w * d * d;
}
fn eval_q(q: &Q, x: f64, y: f64, z: f64) -> f64 {
    q[0] * x * x + 2.0 * q[1] * x * y + 2.0 * q[2] * x * z + 2.0 * q[3] * x + q[4] * y * y + 2.0 * q[5] * y * z + 2.0 * q[6] * y + q[7] * z * z + 2.0 * q[8] * z + q[9]
}

#[derive(Clone, Copy)]
struct Entry { cost: f64, a: u32, b: u32, va: u32, vb: u32 }
impl PartialEq for Entry { fn eq(&self, o: &Self) -> bool { self.cmp(o) == Ordering::Equal } }
impl Eq for Entry {}
impl PartialOrd for Entry { fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) } }
impl Ord for Entry {
    // BinaryHeap is a max-heap: reverse the order so the smallest cost pops first; ties by vertex ids so the result is deterministic
    fn cmp(&self, o: &Self) -> Ordering { o.cost.total_cmp(&self.cost).then_with(|| o.a.cmp(&self.a)).then_with(|| o.b.cmp(&self.b)) }
}

struct Out { pos: Vec<f64>, idx: Vec<u32>, labels: Vec<u16>, collapses: u32, max_cost: f64 }
static mut OUT: Option<Out> = None;

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 { let mut v: Vec<u8> = Vec::with_capacity(n.max(8)); let p = v.as_mut_ptr(); std::mem::forget(v); p }
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) { drop(Vec::from_raw_parts(p, 0, n.max(8))); }

#[allow(static_mut_refs)]
fn out() -> &'static Out { unsafe { OUT.as_ref().expect("no result") } }
#[no_mangle] pub extern "C" fn out_nv() -> u32 { (out().pos.len() / 3) as u32 }
#[no_mangle] pub extern "C" fn out_nt() -> u32 { (out().idx.len() / 3) as u32 }
#[no_mangle] pub extern "C" fn out_pos() -> *const f64 { out().pos.as_ptr() }
#[no_mangle] pub extern "C" fn out_idx() -> *const u32 { out().idx.as_ptr() }
#[no_mangle] pub extern "C" fn out_labels() -> *const u16 { out().labels.as_ptr() }
#[no_mangle] pub extern "C" fn out_collapses() -> u32 { out().collapses }
#[no_mangle] pub extern "C" fn out_max_cost() -> f64 { out().max_cost }

struct St {
    p: Vec<f64>,
    t: Vec<u32>,
    alive: Vec<bool>,
    vt: Vec<Vec<u32>>,
    n: Vec<f64>,
    area: Vec<f64>,
    q: Vec<Q>,
    locked: Vec<bool>,
    locked_edge: FxMap<u64, ()>,
    version: Vec<u32>,
    dead: Vec<bool>,
    nv: u64,
    size: f64,
}

impl St {
    fn key(&self, a: u32, b: u32) -> u64 { let (lo, hi) = if a < b { (a, b) } else { (b, a) }; lo as u64 * self.nv + hi as u64 }
    fn pt(&self, i: u32) -> [f64; 3] { let i = 3 * i as usize; [self.p[i], self.p[i + 1], self.p[i + 2]] }
    fn face_normal(&mut self, t: usize) {
        let (a, b, c) = (self.t[3 * t], self.t[3 * t + 1], self.t[3 * t + 2]);
        let (pa, pb, pc) = (self.pt(a), self.pt(b), self.pt(c));
        let u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        let v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        self.area[t] = l / 2.0;
        if l > 0.0 { self.n[3 * t] = n[0] / l; self.n[3 * t + 1] = n[1] / l; self.n[3 * t + 2] = n[2] / l; } else { self.n[3 * t] = 0.0; self.n[3 * t + 1] = 0.0; self.n[3 * t + 2] = 0.0; }
    }
    fn neighbours(&self, v: u32, out: &mut Vec<u32>) {
        out.clear();
        for &t in &self.vt[v as usize] {
            let t = t as usize;
            if !self.alive[t] { continue; }
            for k in 0..3 { let w = self.t[3 * t + k]; if w != v { out.push(w); } }
        }
        out.sort_unstable(); out.dedup();
    }
    fn edge_plane(&mut self, t: usize, a: u32, b: u32, w: f64) {
        let (pa, pb) = (self.pt(a), self.pt(b));
        let e = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        let n = [self.n[3 * t], self.n[3 * t + 1], self.n[3 * t + 2]];
        let mut p = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]];
        let l = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        if l == 0.0 { return; }
        for x in p.iter_mut() { *x /= l; }
        let d = -(p[0] * pa[0] + p[1] * pa[1] + p[2] * pa[2]);
        let el2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
        add_plane(&mut self.q[a as usize], p[0], p[1], p[2], d, w * el2);
        add_plane(&mut self.q[b as usize], p[0], p[1], p[2], d, w * el2);
    }
    fn candidate(&self, a: u32, b: u32) -> Option<([f64; 3], f64)> {
        let (la, lb) = (self.locked[a as usize], self.locked[b as usize]);
        let on_edge = self.locked_edge.contains_key(&self.key(a, b));
        if la && lb && !on_edge { return None; }
        let mut q = [0.0; 10];
        for i in 0..10 { q[i] = self.q[a as usize][i] + self.q[b as usize][i]; }
        let (pa, pb) = (self.pt(a), self.pt(b));
        let mid = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0, (pa[2] + pb[2]) / 2.0];
        let opts: &[[f64; 3]] = if la && !lb { &[pa] } else if lb && !la { &[pb] } else if la && lb { &[pa, pb] } else { &[pa, pb, mid] };
        let len2 = (pa[0] - pb[0]).powi(2) + (pa[1] - pb[1]).powi(2) + (pa[2] - pb[2]).powi(2);
        let mut best: Option<([f64; 3], f64)> = None;
        for p in opts {
            let c = eval_q(&q, p[0], p[1], p[2]).max(0.0) + 1e-9 * len2;
            if best.map_or(true, |(_, bc)| c < bc) { best = Some((*p, c)); }
        }
        best
    }
}

/// Returns 0 on success, 1 when nothing needed doing (the caller keeps its mesh), 2 for bad input.
#[no_mangle]
pub unsafe extern "C" fn decimate(pos: *const f64, nv: u32, idx: *const u32, nt: u32, labels: *const u16, target: u32, max_err2: f64, keep_boundary: u32, keep_creases: u32, crease_cos: f64) -> i32 {
    let (nv, nt) = (nv as usize, nt as usize);
    if nt == 0 || nv == 0 { return 2; }
    let target = target.max(4) as usize;
    if nt <= target { return 1; }
    let p = std::slice::from_raw_parts(pos, nv * 3).to_vec();
    let t = std::slice::from_raw_parts(idx, nt * 3).to_vec();
    if t.iter().any(|&i| i as usize >= nv) { return 2; }
    let lab: Option<Vec<u16>> = if labels.is_null() { None } else { Some(std::slice::from_raw_parts(labels, nt).to_vec()) };

    let mut s = St {
        p, t, alive: vec![true; nt], vt: vec![Vec::new(); nv], n: vec![0.0; 3 * nt], area: vec![0.0; nt], q: vec![[0.0; 10]; nv],
        locked: vec![false; nv], locked_edge: FxMap::default(), version: vec![0; nv], dead: vec![false; nv], nv: nv as u64, size: 0.0,
    };
    for ti in 0..nt { for k in 0..3 { let v = s.t[3 * ti + k] as usize; s.vt[v].push(ti as u32); } }
    for ti in 0..nt { s.face_normal(ti); }
    for v in 0..3 * nv { s.size = s.size.max(s.p[v].abs()); }

    // which triangles share each edge: up to two are kept, a third marks it non-manifold
    let mut edge: FxMap<u64, (u32, u32, u8)> = FxMap::default();
    for ti in 0..nt {
        for k in 0..3 {
            let key = s.key(s.t[3 * ti + k], s.t[3 * ti + (k + 1) % 3]);
            let e = edge.entry(key).or_insert((u32::MAX, u32::MAX, 0));
            if e.2 == 0 { e.0 = ti as u32; } else if e.2 == 1 { e.1 = ti as u32; }
            e.2 = e.2.saturating_add(1);
        }
    }
    for ti in 0..nt {
        let (a, b, c) = (s.t[3 * ti] as usize, s.t[3 * ti + 1] as usize, s.t[3 * ti + 2] as usize);
        let nx = s.n[3 * ti]; let ny = s.n[3 * ti + 1]; let nz = s.n[3 * ti + 2];
        let d = -(nx * s.p[3 * a] + ny * s.p[3 * a + 1] + nz * s.p[3 * a + 2]);
        let ar = s.area[ti];
        for v in [a, b, c] { add_plane(&mut s.q[v], nx, ny, nz, d, ar); }
    }
    let mut keys: Vec<u64> = edge.keys().copied().collect();
    keys.sort_unstable(); // a fixed order, so the same input gives the same output
    for k in &keys {
        let (t0, t1, cnt) = edge[k];
        let (a, b) = ((k / s.nv) as u32, (k % s.nv) as u32);
        let hold = if cnt == 1 { keep_boundary != 0 } else if cnt == 2 {
            let (t0, t1) = (t0 as usize, t1 as usize);
            let dot = s.n[3 * t0] * s.n[3 * t1] + s.n[3 * t0 + 1] * s.n[3 * t1 + 1] + s.n[3 * t0 + 2] * s.n[3 * t1 + 2];
            let border = lab.as_ref().map_or(false, |l| l[t0] != l[t1]);
            (keep_creases != 0 && dot < crease_cos) || border
        } else { true };
        if hold {
            s.locked_edge.insert(*k, ()); s.locked[a as usize] = true; s.locked[b as usize] = true;
            let list: Vec<usize> = if cnt == 1 { vec![t0 as usize] } else if cnt == 2 { vec![t0 as usize, t1 as usize] } else { Vec::new() };
            for ti in list { s.edge_plane(ti, a, b, 100.0); }
        }
    }

    let mut heap: BinaryHeap<Entry> = BinaryHeap::new();
    for k in &keys {
        let (a, b) = ((k / s.nv) as u32, (k % s.nv) as u32);
        if let Some((_, c)) = s.candidate(a, b) { heap.push(Entry { cost: c, a, b, va: s.version[a as usize], vb: s.version[b as usize] }); }
    }

    let mut tri_count = nt;
    let (mut collapses, mut max_cost) = (0u32, 0.0f64);
    let (mut na, mut nb, mut shared, mut corners): (Vec<u32>, Vec<u32>, Vec<u32>, Vec<u32>) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut around: Vec<u32> = Vec::new();
    while tri_count > target {
        let Some(e) = heap.pop() else { break };
        let (a, b) = (e.a, e.b);
        if s.dead[a as usize] || s.dead[b as usize] || s.version[a as usize] != e.va || s.version[b as usize] != e.vb { continue; }
        if e.cost > max_err2 { break; }
        s.neighbours(a, &mut na);
        if na.binary_search(&b).is_err() { continue; }
        s.neighbours(b, &mut nb);
        // link condition: the neighbours the two vertices share are exactly the far corners of the triangles on the edge
        shared.clear();
        for w in &na { if nb.binary_search(w).is_ok() { shared.push(*w); } }
        around.clear();
        for &t in &s.vt[a as usize] {
            let ti = t as usize;
            if s.alive[ti] && (s.t[3 * ti] == b || s.t[3 * ti + 1] == b || s.t[3 * ti + 2] == b) { around.push(t); }
        }
        around.sort_unstable(); around.dedup();
        corners.clear();
        for &t in &around { for k in 0..3 { let w = s.t[3 * t as usize + k]; if w != a && w != b { corners.push(w); } } }
        corners.sort_unstable(); corners.dedup();
        if shared != corners { continue; }
        let Some((c, _)) = s.candidate(a, b) else { continue };
        // no triangle may fold over or collapse into a sliver
        let mut ok = true;
        'outer: for v in [a, b] {
            for &t in &s.vt[v as usize] {
                let ti = t as usize;
                if !s.alive[ti] || around.binary_search(&t).is_ok() { continue; }
                let pt = |i: u32| if i == a || i == b { c } else { s.pt(i) };
                let (p0, p1, p2) = (pt(s.t[3 * ti]), pt(s.t[3 * ti + 1]), pt(s.t[3 * ti + 2]));
                let u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
                let w = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
                let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
                let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                if l < 1e-12 * (1.0f64).max(s.size * s.size) { ok = false; break 'outer; }
                if (n[0] * s.n[3 * ti] + n[1] * s.n[3 * ti + 1] + n[2] * s.n[3 * ti + 2]) / l < 0.2 { ok = false; break 'outer; }
            }
        }
        if !ok { continue; }

        // collapse b into a
        let (ai, bi) = (a as usize, b as usize);
        s.p[3 * ai] = c[0]; s.p[3 * ai + 1] = c[1]; s.p[3 * ai + 2] = c[2];
        for i in 0..10 { let add = s.q[bi][i]; s.q[ai][i] += add; }
        if s.locked[bi] { s.locked[ai] = true; }
        for &t in &around { s.alive[t as usize] = false; tri_count -= 1; }
        let moved = std::mem::take(&mut s.vt[bi]);
        for t in moved {
            let ti = t as usize;
            if !s.alive[ti] { continue; }
            for k in 0..3 { if s.t[3 * ti + k] == b { s.t[3 * ti + k] = a; } }
            s.vt[ai].push(t);
        }
        s.dead[bi] = true;
        s.version[ai] += 1;
        let alive = &s.alive;
        let mut list = std::mem::take(&mut s.vt[ai]);
        list.retain(|&t| alive[t as usize]);
        list.sort_unstable(); list.dedup();
        for &t in &list { s.face_normal(t as usize); }
        s.vt[ai] = list;
        s.neighbours(a, &mut na);
        let ws = na.clone();
        for w in ws {
            if let Some((_, cst)) = s.candidate(a, w) { heap.push(Entry { cost: cst, a, b: w, va: s.version[ai], vb: s.version[w as usize] }); }
        }
        collapses += 1;
        if e.cost > max_cost { max_cost = e.cost; }
    }

    // compact
    let mut vmap = vec![u32::MAX; nv];
    let (mut out_p, mut out_t, mut out_l) = (Vec::new(), Vec::new(), Vec::new());
    for ti in 0..nt {
        if !s.alive[ti] { continue; }
        for k in 0..3 {
            let v = s.t[3 * ti + k] as usize;
            if vmap[v] == u32::MAX { vmap[v] = (out_p.len() / 3) as u32; out_p.extend_from_slice(&s.p[3 * v..3 * v + 3]); }
            out_t.push(vmap[v]);
        }
        if let Some(l) = &lab { out_l.push(l[ti]); }
    }
    OUT = Some(Out { pos: out_p, idx: out_t, labels: out_l, collapses, max_cost });
    0
}
