/**
 * Hierarchical Risk Parity (HRP)
 * Lopez de Prado (2016)
 *
 * 1. Compute distance matrix from correlation matrix
 * 2. Single-linkage hierarchical clustering
 * 3. Quasi-diagonalize covariance matrix
 * 4. Recursive bisection for weight allocation
 */

import { covToCorr } from './covariance.js';

export interface HRPResult {
  weights: number[];
  clusterOrder: number[];
}

/** Distance matrix from correlation: d_ij = sqrt(0.5 * (1 - corr_ij)) */
export function correlationDistance(corr: number[][]): number[][] {
  return corr.map(row => row.map(v => Math.sqrt(0.5 * (1 - v))));
}

/** Single-linkage hierarchical clustering, returns merge order */
export function singleLinkageClustering(dist: number[][]): number[] {
  const n = dist.length;
  const active = new Set(Array.from({ length: n }, (_, i) => i));
  const clusters: Map<number, number[]> = new Map();
  for (let i = 0; i < n; i++) clusters.set(i, [i]);

  const d = dist.map(row => [...row]);
  const mergeOrder: number[] = [];
  let nextCluster = n;

  while (active.size > 1) {
    // Find closest pair
    let minDist = Infinity;
    let mi = -1, mj = -1;
    for (const i of active) {
      for (const j of active) {
        if (i < j && d[i][j] < minDist) {
          minDist = d[i][j];
          mi = i; mj = j;
        }
      }
    }

    // Merge clusters
    const merged = [...(clusters.get(mi) || []), ...(clusters.get(mj) || [])];
    clusters.set(nextCluster, merged);
    active.delete(mi);
    active.delete(mj);

    // Update distances (single linkage = min)
    if (d.length <= nextCluster) {
      for (let i = 0; i < d.length; i++) d[i].push(Infinity);
      d.push(new Array(nextCluster + 1).fill(Infinity));
    }
    for (const k of active) {
      const dk = Math.min(d[mi]?.[k] ?? Infinity, d[mj]?.[k] ?? Infinity);
      d[nextCluster][k] = dk;
      d[k][nextCluster] = dk;
    }
    d[nextCluster][nextCluster] = 0;

    active.add(nextCluster);
    mergeOrder.push(...merged);
    nextCluster++;
  }

  // Return leaf ordering from final cluster
  const lastCluster = Math.max(...active);
  return clusters.get(lastCluster) || mergeOrder;
}

/** Quasi-diagonalize: reorder covariance matrix by cluster order */
export function quasiDiagonalize(cov: number[][], order: number[]): number[][] {
  return order.map(i => order.map(j => cov[i][j]));
}

/** Recursive bisection to compute HRP weights */
export function recursiveBisection(cov: number[][], order: number[]): number[] {
  const n = cov.length;
  const weights = new Array(n).fill(1);

  function clusterVariance(indices: number[]): number {
    if (indices.length === 1) return cov[indices[0]][indices[0]];
    // Inverse-variance weights within cluster
    const ivp = indices.map(i => 1 / cov[i][i]);
    const sumIvp = ivp.reduce((s, v) => s + v, 0);
    const w = ivp.map(v => v / sumIvp);
    // Portfolio variance
    let v = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = 0; b < indices.length; b++) {
        v += w[a] * w[b] * cov[indices[a]][indices[b]];
      }
    }
    return v;
  }

  function bisect(items: number[]): void {
    if (items.length <= 1) return;
    const mid = Math.floor(items.length / 2);
    const left = items.slice(0, mid);
    const right = items.slice(mid);

    const vl = clusterVariance(left);
    const vr = clusterVariance(right);
    const alpha = 1 - vl / (vl + vr); // allocate more to lower-variance cluster

    for (const i of left) weights[i] *= alpha;
    for (const i of right) weights[i] *= (1 - alpha);

    bisect(left);
    bisect(right);
  }

  bisect(order);

  // Normalize
  const sum = weights.reduce((s, w) => s + w, 0);
  return weights.map(w => w / sum);
}

/** Full HRP pipeline */
export function hrpWeights(covMatrix: number[][]): HRPResult {
  const corr = covToCorr(covMatrix);
  const dist = correlationDistance(corr);
  const order = singleLinkageClustering(dist);
  const reordered = quasiDiagonalize(covMatrix, order);
  const reorderedIndices = order.map((_, i) => i);
  const reorderedWeights = recursiveBisection(reordered, reorderedIndices);

  // Map back to original indices
  const weights = new Array(covMatrix.length).fill(0);
  for (let i = 0; i < order.length; i++) {
    weights[order[i]] = reorderedWeights[i];
  }

  return { weights, clusterOrder: order };
}
