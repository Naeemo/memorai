// BM25 inverted index — small dependency-free sparse retrieval.
//
// Implements Okapi BM25 with k1 = 1.5, b = 0.75. Tokenization is lowercase
// alphanumeric word-split with a tiny English stopword filter. Suitable for
// chat memories and short text; not optimized for large documents.

const K1 = 1.5;
const B = 0.75;

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "as",
  "from",
  "into",
  "about",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "they",
  "them",
  "their",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "might",
  "shall",
  "if",
  "then",
  "else",
  "than",
  "so",
  "not",
  "no",
  "yes",
  "such",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

interface DocStats {
  length: number; // number of tokens in this doc
  termFreq: Map<string, number>;
}

export class BM25Index {
  private docs = new Map<string, DocStats>();
  private termDocCount = new Map<string, number>(); // term -> # docs containing it
  private termPosting = new Map<string, Set<string>>(); // term -> docIds
  private totalLength = 0;

  /** Add or replace a document in the index. */
  put(docId: string, text: string): void {
    this.remove(docId);
    const tokens = tokenize(text);
    if (tokens.length === 0) return;

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    this.docs.set(docId, { length: tokens.length, termFreq: tf });
    this.totalLength += tokens.length;

    for (const term of tf.keys()) {
      this.termDocCount.set(term, (this.termDocCount.get(term) ?? 0) + 1);
      let posting = this.termPosting.get(term);
      if (!posting) {
        posting = new Set();
        this.termPosting.set(term, posting);
      }
      posting.add(docId);
    }
  }

  /** Remove a document from the index. */
  remove(docId: string): void {
    const stats = this.docs.get(docId);
    if (!stats) return;
    this.totalLength -= stats.length;
    for (const term of stats.termFreq.keys()) {
      const count = this.termDocCount.get(term) ?? 0;
      if (count <= 1) {
        this.termDocCount.delete(term);
      } else {
        this.termDocCount.set(term, count - 1);
      }
      const posting = this.termPosting.get(term);
      if (posting) {
        posting.delete(docId);
        if (posting.size === 0) this.termPosting.delete(term);
      }
    }
    this.docs.delete(docId);
  }

  /** Number of documents in the index. */
  size(): number {
    return this.docs.size;
  }

  /**
   * Score documents matching the query. Returns the top `limit` docIds with
   * their BM25 scores, sorted descending.
   */
  search(query: string, limit = 50): Array<{ docId: string; score: number }> {
    const terms = tokenize(query);
    if (terms.length === 0 || this.docs.size === 0) return [];

    const avgLen = this.totalLength / this.docs.size;
    const N = this.docs.size;

    // Candidate docs: union of postings for query terms.
    const candidates = new Set<string>();
    for (const term of terms) {
      const posting = this.termPosting.get(term);
      if (posting) for (const id of posting) candidates.add(id);
    }
    if (candidates.size === 0) return [];

    const scored: Array<{ docId: string; score: number }> = [];
    for (const docId of candidates) {
      const stats = this.docs.get(docId);
      if (!stats) continue;
      let score = 0;
      for (const term of terms) {
        const tf = stats.termFreq.get(term);
        if (!tf) continue;
        const df = this.termDocCount.get(term) ?? 0;
        if (df === 0) continue;
        // Robertson-Sparck-Jones IDF, clamped to >=0
        const idf = Math.max(0, Math.log((N - df + 0.5) / (df + 0.5) + 1));
        const norm = 1 - B + B * (stats.length / avgLen);
        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * norm);
        score += idf * tfNorm;
      }
      if (score > 0) scored.push({ docId, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Clear all documents. */
  clear(): void {
    this.docs.clear();
    this.termDocCount.clear();
    this.termPosting.clear();
    this.totalLength = 0;
  }
}
