/**
 * @file movie-search.ts
 * @description Movie search using TMDB API with embedded watch links via screenfetch2.xyz.
 *
 * Flow:
 *  1. searchMovies(query)      → top N results (movies + TV shows) with metadata
 *  2. getMovieWatchLink(tmdbId, mediaType) → embedded watch URL ready to open in a browser
 *
 * API used:
 *  - TMDB search: GET /3/search/multi?api_key=...&query=...&page=1
 *  - Embedded player: https://screenfetch2.xyz/embed/movie?tmdb={ID}&o=https%3A%2F%2Ffilmpire.sc
 *  - Embedded player (TV): https://screenfetch2.xyz/embed/tv?tmdb={ID}&o=https%3A%2F%2Ffilmpire.sc
 */

import * as https from 'https';
import { IncomingMessage } from 'http';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// TMDB_API_KEY will be read dynamically inside the functions.
const TMDB_BASE_URL = 'https://api.themoviedb.org';
const EMBED_BASE_URL = 'https://screenfetch2.xyz';
const FILMPIRE_ORIGIN = encodeURIComponent('https://filmpire.sc');
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MovieMediaType = 'movie' | 'tv';

/**
 * A simplified movie/TV search result.
 */
export interface MovieSearchResult {
  tmdbId: number;
  title: string;
  overview: string;
  posterPath: string | null;
  mediaType: MovieMediaType;
  releaseDate: string;
  voteAverage: number;
  voteCount: number;
  /** Full poster URL (or empty string if no poster) */
  posterUrl: string;
  /** Ready-to-watch embedded player URL */
  watchUrl: string;
}

// ---------------------------------------------------------------------------
// Raw TMDB response shapes (private)
// ---------------------------------------------------------------------------

interface TmdbRawResult {
  id: number;
  media_type: string;
  title?: string;           // movies
  name?: string;            // TV shows
  overview: string;
  poster_path: string | null;
  release_date?: string;    // movies
  first_air_date?: string;  // TV
  vote_average: number;
  vote_count: number;
}

interface TmdbSearchResponse {
  page: number;
  results: TmdbRawResult[];
  total_pages: number;
  total_results: number;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Performs a simple HTTPS GET and returns the parsed JSON body.
 * Follows up to one redirect.
 */
function httpsGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const doGet = (targetUrl: string) => {
      https.get(
        targetUrl,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0 Safari/537.36',
            Accept: 'application/json',
            'Accept-Language': 'en-GB,en;q=0.9',
            Origin: 'https://filmpire.sc',
            Referer: 'https://filmpire.sc/',
          },
        },
        (res: IncomingMessage) => {
          // Follow redirect
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            doGet(res.headers.location);
            return;
          }

          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} from TMDB API`));
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
            } catch (e) {
              reject(new Error(`Failed to parse TMDB JSON: ${e}`));
            }
          });
          res.on('error', reject);
        },
      ).on('error', reject);
    };

    doGet(url);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the embedded player URL for a movie or TV show.
 *
 * Movie:  https://screenfetch2.xyz/embed/movie?tmdb={ID}&o=https%3A%2F%2Ffilmpire.sc
 * TV:     https://screenfetch2.xyz/embed/tv?tmdb={ID}&o=https%3A%2F%2Ffilmpire.sc
 */
export function buildWatchUrl(tmdbId: number, mediaType: MovieMediaType): string {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  return `${EMBED_BASE_URL}/embed/${type}?tmdb=${tmdbId}&o=${FILMPIRE_ORIGIN}`;
}

/** Star rating string like ⭐ 7.9 (1,234 votes) */
function fmtRating(avg: number, count: number): string {
  const stars = avg > 0 ? `⭐ ${avg.toFixed(1)}` : '⭐ N/A';
  const votes = count > 0 ? ` (${count.toLocaleString('en-US')} votes)` : '';
  return `${stars}${votes}`;
}

/** Converts a raw TMDB result to our clean MovieSearchResult type */
function mapResult(raw: TmdbRawResult): MovieSearchResult | null {
  const mediaType = raw.media_type === 'tv' ? 'tv' : 'movie';
  // Skip person results
  if (raw.media_type === 'person') return null;

  const title = raw.title ?? raw.name ?? 'Unknown';
  const releaseDate = raw.release_date ?? raw.first_air_date ?? '';
  const posterUrl = raw.poster_path
    ? `${TMDB_IMAGE_BASE}${raw.poster_path}`
    : '';

  return {
    tmdbId: raw.id,
    title,
    overview: raw.overview,
    posterPath: raw.poster_path,
    mediaType,
    releaseDate,
    voteAverage: raw.vote_average,
    voteCount: raw.vote_count,
    posterUrl,
    watchUrl: buildWatchUrl(raw.id, mediaType),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Searches TMDB for movies and TV shows matching the query.
 *
 * @param query  User search query (e.g. "spiderman")
 * @param limit  Max number of results to return (default: 5)
 * @param page   TMDB page number (default: 1)
 */
export async function searchMovies(
  query: string,
  limit = 5,
  page = 1,
): Promise<MovieSearchResult[]> {
  const TMDB_API_KEY = process.env.TMDB_API_KEY;
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY environment variable is not set');
  const encoded = encodeURIComponent(query.trim());
  const url = `${TMDB_BASE_URL}/3/search/multi?api_key=${TMDB_API_KEY}&query=${encoded}&page=${page}`;

  const data = await httpsGetJson<TmdbSearchResponse>(url);

  return data.results
    .map(mapResult)
    .filter((r): r is MovieSearchResult => r !== null)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// WhatsApp message formatters
// ---------------------------------------------------------------------------

/**
 * Formats a single movie search result into a WhatsApp message line.
 *
 * Example:
 *   *1. Spider-Man: No Way Home* (2021) 🎬
 *   ⭐ 7.9 (21,869 votes)
 *   📖 Peter Parker is unmasked…
 *   🎬 Watch: https://screenfetch2.xyz/embed/movie?tmdb=634649&o=…
 */
export function formatMovieResult(result: MovieSearchResult, index: number): string {
  const year = result.releaseDate ? ` (${result.releaseDate.slice(0, 4)})` : '';
  const typeEmoji = result.mediaType === 'tv' ? '📺' : '🎬';
  const rating = fmtRating(result.voteAverage, result.voteCount);
  const overview = result.overview
    ? result.overview.length > 150
      ? result.overview.slice(0, 147) + '…'
      : result.overview
    : 'No overview available.';

  return (
    `*${index + 1}. ${result.title}*${year} ${typeEmoji}\n` +
    `${rating}\n` +
    `📖 _${overview}_\n` +
    `🎬 *Watch:* ${result.watchUrl}`
  );
}

/**
 * Builds the full search-results WhatsApp message block.
 */
export function formatMovieSearchMessage(
  results: MovieSearchResult[],
  query: string,
): string {
  const lines = results.map((r, i) => formatMovieResult(r, i)).join('\n\n---\n\n');
  return (
    `🎥 *Movie Search Results*\n` +
    `_Query: "${query}"_\n\n` +
    lines +
    `\n\n_Reply with a number (1–${results.length}) to get the direct watch link._`
  );
}
