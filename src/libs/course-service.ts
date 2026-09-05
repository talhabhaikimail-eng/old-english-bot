import { Pool } from 'pg';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { browserPool } from './browser-pool';

const COURSES_DB_URL = (process.env.COURSES_DATABASE_URL || process.env.DATABASE_URL || '').trim();
const DRIVE_DB_URL = (process.env.DATABASE_URL || '').trim();
const DRIVE_API_BASE = (process.env.DRIVE_API_BASE || '').replace(/\/+$/, '');
const DRIVE_API_USER = (process.env.DRIVE_API_USER || '').trim();
const DRIVE_API_PASS = (process.env.DRIVE_API_PASS || '').trim();

let coursesPool: Pool | null = null;
let drivePool: Pool | null = null;

export function getCoursesPool(): Pool {
  if (!COURSES_DB_URL) {
    throw new Error('COURSES_DATABASE_URL (or DATABASE_URL) environment variable is not set. Please define it in your .env file.');
  }
  if (!coursesPool) {
    coursesPool = new Pool({
      connectionString: COURSES_DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }
  return coursesPool;
}

export function getDrivePool(): Pool {
  if (!DRIVE_DB_URL) {
    throw new Error('DATABASE_URL environment variable is not set. Please define it in your .env file.');
  }
  if (!drivePool) {
    drivePool = new Pool({
      connectionString: DRIVE_DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return drivePool;
}

export interface CourseListParams {
  page?: number;
  limit?: number;
  search?: string;
  topic?: string;
  driveStatus?: string; // 'all' | 'pending' | 'uploading' | 'completed' | 'failed'
  sort?: string; // 'relevance' | 'newest' | 'rating' | 'size' | 'title'
}

export interface CourseSummary {
  id: string;
  postId?: number;
  title: string;
  slug: string;
  topic?: string;
  primaryCategory?: string;
  tags?: string[];
  featuredImage?: string;
  statedSizeText?: string;
  calculatedSizeBytes?: number;
  downloadLinksCount: number;
  downloadLinks?: Array<{
    part: number;
    url: string;
    text: string;
    sizeText?: string | null;
    bytes: number;
  }>;
  filePassword?: string;
  rating?: {
    score?: number;
    best?: number;
    votes?: number;
  };
  courseSpecs?: Record<string, any>;
  driveStatus: string;
  driveCourseId?: string;
  driveFolderId?: string;
  driveFolderName?: string;
  driveVideosCount: number;
  driveVideos?: Array<{
    index: number;
    fileName: string;
    relativePath: string;
    sizeMB: string;
    status: string;
    driveFileId?: string;
    driveViewLink?: string;
  }>;
  driveUploadedAt?: string;
  driveError?: string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export async function listCourses(params: CourseListParams = {}): Promise<{
  data: CourseSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const pool = getCoursesPool();
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 24));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const queryParams: any[] = [];
  let pIdx = 1;

  if (params.search && params.search.trim()) {
    const s = params.search.trim();
    conditions.push(`(
      title ILIKE $${pIdx} 
      OR slug ILIKE $${pIdx} 
      OR topic ILIKE $${pIdx} 
      OR primary_category ILIKE $${pIdx}
    )`);
    queryParams.push(`%${s}%`);
    pIdx++;
  }

  if (params.topic && params.topic !== 'all') {
    conditions.push(`(primary_category = $${pIdx} OR topic = $${pIdx})`);
    queryParams.push(params.topic);
    pIdx++;
  }

  if (params.driveStatus && params.driveStatus !== 'all') {
    if (params.driveStatus === 'pending') {
      conditions.push(`(drive_status = 'pending' OR drive_status IS NULL)`);
    } else {
      conditions.push(`drive_status = $${pIdx}`);
      queryParams.push(params.driveStatus);
      pIdx++;
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  let orderClause = 'ORDER BY calculated_size_bytes DESC NULLS LAST, created_at DESC';
  if (params.sort === 'newest') {
    orderClause = 'ORDER BY published_at DESC NULLS LAST, created_at DESC';
  } else if (params.sort === 'rating') {
    orderClause = 'ORDER BY (rating->>\'score\')::numeric DESC NULLS LAST, (rating->>\'votes\')::numeric DESC NULLS LAST';
  } else if (params.sort === 'title') {
    orderClause = 'ORDER BY title ASC';
  } else if (params.sort === 'size') {
    orderClause = 'ORDER BY calculated_size_bytes DESC NULLS LAST';
  }

  const countSql = `SELECT count(*)::int as total FROM courses ${whereClause}`;
  const countRes = await pool.query(countSql, queryParams);
  const total = countRes.rows[0]?.total || 0;

  const dataSql = `
    SELECT 
      id, post_id, title, slug, topic, primary_category, tags, featured_image,
      stated_size_text, calculated_size_bytes, download_links, file_password,
      rating, course_specs, drive_status, drive_course_id, drive_folder_id,
      drive_folder_name, drive_videos, drive_uploaded_at, drive_error,
      published_at, created_at, updated_at
    FROM courses
    ${whereClause}
    ${orderClause}
    LIMIT $${pIdx} OFFSET $${pIdx + 1}
  `;
  queryParams.push(limit, offset);

  const dataRes = await pool.query(dataSql, queryParams);

  const data: CourseSummary[] = dataRes.rows.map(r => {
    const downloadLinks = Array.isArray(r.download_links) ? r.download_links : [];
    const driveVideos = Array.isArray(r.drive_videos) ? r.drive_videos : [];
    return {
      id: r.id,
      postId: r.post_id,
      title: r.title,
      slug: r.slug,
      topic: r.topic,
      primaryCategory: r.primary_category,
      tags: r.tags || [],
      featuredImage: r.featured_image,
      statedSizeText: r.stated_size_text,
      calculatedSizeBytes: r.calculated_size_bytes ? Number(r.calculated_size_bytes) : undefined,
      downloadLinksCount: downloadLinks.length,
      downloadLinks,
      filePassword: r.file_password,
      rating: r.rating || {},
      courseSpecs: r.course_specs || {},
      driveStatus: r.drive_status || 'pending',
      driveCourseId: r.drive_course_id,
      driveFolderId: r.drive_folder_id,
      driveFolderName: r.drive_folder_name,
      driveVideosCount: driveVideos.length,
      driveVideos,
      driveUploadedAt: r.drive_uploaded_at ? new Date(r.drive_uploaded_at).toISOString() : undefined,
      driveError: r.drive_error,
      publishedAt: r.published_at ? new Date(r.published_at).toISOString() : undefined,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
    };
  });

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getCourseStats(): Promise<{
  total: number;
  pending: number;
  uploading: number;
  completed: number;
  failed: number;
  totalSizeBytes: number;
}> {
  const pool = getCoursesPool();
  const sql = `
    SELECT 
      count(*)::int as total,
      count(case when drive_status = 'pending' or drive_status is null then 1 end)::int as pending,
      count(case when drive_status = 'uploading' then 1 end)::int as uploading,
      count(case when drive_status = 'completed' then 1 end)::int as completed,
      count(case when drive_status = 'failed' then 1 end)::int as failed,
      coalesce(sum(calculated_size_bytes), 0)::bigint as total_bytes
    FROM courses
  `;
  const res = await pool.query(sql);
  const row = res.rows[0] || {};
  return {
    total: row.total || 0,
    pending: row.pending || 0,
    uploading: row.uploading || 0,
    completed: row.completed || 0,
    failed: row.failed || 0,
    totalSizeBytes: Number(row.total_bytes || 0),
  };
}

export async function getCourseTopics(): Promise<Array<{ name: string; count: number }>> {
  const pool = getCoursesPool();
  const sql = `
    SELECT coalesce(primary_category, topic, 'General') as name, count(*)::int as count
    FROM courses
    WHERE coalesce(primary_category, topic) is not null AND coalesce(primary_category, topic) != ''
    GROUP BY coalesce(primary_category, topic)
    ORDER BY count DESC
    LIMIT 50
  `;
  const res = await pool.query(sql);
  return res.rows.map(r => ({ name: r.name, count: r.count }));
}

export async function getCourseById(idOrSlug: string): Promise<CourseSummary | null> {
  const pool = getCoursesPool();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

  const sql = `
    SELECT 
      id, post_id, title, slug, topic, primary_category, tags, featured_image,
      stated_size_text, calculated_size_bytes, download_links, file_password,
      rating, course_specs, drive_status, drive_course_id, drive_folder_id,
      drive_folder_name, drive_videos, drive_uploaded_at, drive_error,
      published_at, created_at, updated_at
    FROM courses
    WHERE ${isUuid ? 'id = $1' : 'slug = $1 OR title = $1'}
    LIMIT 1
  `;
  const res = await pool.query(sql, [idOrSlug]);
  if (res.rows.length === 0) return null;

  const r = res.rows[0];
  const downloadLinks = Array.isArray(r.download_links) ? r.download_links : [];
  const driveVideos = Array.isArray(r.drive_videos) ? r.drive_videos : [];

  return {
    id: r.id,
    postId: r.post_id,
    title: r.title,
    slug: r.slug,
    topic: r.topic,
    primaryCategory: r.primary_category,
    tags: r.tags || [],
    featuredImage: r.featured_image,
    statedSizeText: r.stated_size_text,
    calculatedSizeBytes: r.calculated_size_bytes ? Number(r.calculated_size_bytes) : undefined,
    downloadLinksCount: downloadLinks.length,
    downloadLinks,
    filePassword: r.file_password,
    rating: r.rating || {},
    courseSpecs: r.course_specs || {},
    driveStatus: r.drive_status || 'pending',
    driveCourseId: r.drive_course_id,
    driveFolderId: r.drive_folder_id,
    driveFolderName: r.drive_folder_name,
    driveVideosCount: driveVideos.length,
    driveVideos,
    driveUploadedAt: r.drive_uploaded_at ? new Date(r.drive_uploaded_at).toISOString() : undefined,
    driveError: r.drive_error,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : undefined,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
  };
}

export async function updateCourseDriveStatus(
  courseId: string,
  update: {
    driveStatus: string;
    driveCourseId?: string;
    driveFolderId?: string;
    driveFolderName?: string;
    driveVideos?: any[];
    driveError?: string | null;
  }
): Promise<boolean> {
  const pool = getCoursesPool();
  const fields: string[] = ['drive_status = $1', 'updated_at = NOW()'];
  const values: any[] = [update.driveStatus];
  let idx = 2;

  if (update.driveCourseId !== undefined) {
    fields.push(`drive_course_id = $${idx++}`);
    values.push(update.driveCourseId);
  }
  if (update.driveFolderId !== undefined) {
    fields.push(`drive_folder_id = $${idx++}`);
    values.push(update.driveFolderId);
  }
  if (update.driveFolderName !== undefined) {
    fields.push(`drive_folder_name = $${idx++}`);
    values.push(update.driveFolderName);
  }
  if (update.driveVideos !== undefined) {
    fields.push(`drive_videos = $${idx++}`);
    values.push(JSON.stringify(update.driveVideos));
  }
  if (update.driveError !== undefined) {
    fields.push(`drive_error = $${idx++}`);
    values.push(update.driveError);
  }
  if (update.driveStatus === 'completed') {
    fields.push('drive_uploaded_at = NOW()');
  }

  values.push(courseId);
  const sql = `UPDATE courses SET ${fields.join(', ')} WHERE id = $${idx} OR slug = $${idx}`;
  const res = await pool.query(sql, values);
  return (res.rowCount ?? 0) > 0;
}

export interface WorkerStatusInfo {
  url: string;
  source: 'local' | 'pool' | 'custom';
  workerId: string;
  status: string;
  disk?: {
    totalGB: number;
    freeGB: number;
    usedGB: number;
    usedPercent: number;
  };
  concurrencyLimit?: number;
  activeCourses?: number;
  totalJobs?: number;
  error?: string;
}

/**
 * Probes candidate course worker endpoints (local :8085, pool workers) and returns active status.
 */
export async function getActiveCourseWorkers(): Promise<WorkerStatusInfo[]> {
  const workers: WorkerStatusInfo[] = [];

  // 1. Check local Go Course Worker on port 8085
  const localUrls = ['http://localhost:8085', 'http://127.0.0.1:8085'];
  let localChecked = false;

  for (const lUrl of localUrls) {
    if (localChecked) break;
    try {
      const resp = await fetch(`${lUrl}/worker/status`, {
        signal: AbortSignal.timeout(1500),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        workers.push({
          url: lUrl,
          source: 'local',
          workerId: data.workerId || 'local-worker',
          status: data.status || 'idle',
          disk: data.disk,
          concurrencyLimit: data.concurrencyLimit,
          activeCourses: data.activeCourses,
          totalJobs: data.totalJobs,
        });
        localChecked = true;
      }
    } catch {
      // Local port 8085 not running right now
    }
  }

  // 2. Check remote workers registered in browserPool with courseWorkerUrl
  const poolItems = browserPool.getActive().filter(b => b.courseWorkerUrl);
  for (const item of poolItems) {
    const wUrl = item.courseWorkerUrl!.replace(/\/+$/, '');
    try {
      const resp = await fetch(`${wUrl}/worker/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        workers.push({
          url: wUrl,
          source: 'pool',
          workerId: item.workerId || data.workerId,
          status: data.status || item.status,
          disk: data.disk,
          concurrencyLimit: data.concurrencyLimit,
          activeCourses: data.activeCourses,
          totalJobs: data.totalJobs,
        });
      } else {
        workers.push({
          url: wUrl,
          source: 'pool',
          workerId: item.workerId,
          status: 'unreachable',
          error: `HTTP ${resp.status}`,
        });
      }
    } catch (e: any) {
      workers.push({
        url: wUrl,
        source: 'pool',
        workerId: item.workerId,
        status: 'unreachable',
        error: e.message,
      });
    }
  }

  return workers;
}

/**
 * Submits a course from database to the Go Course Worker.
 */
export async function triggerCourseDownloadAndUpload(
  courseIdOrSlug: string,
  options: {
    workerUrl?: string;
    parentFolderId?: string;
    password?: string;
    autoUpload?: boolean;
  } = {}
): Promise<{ success: boolean; jobId: string; message: string; workerUrl: string }> {
  const course = await getCourseById(courseIdOrSlug);
  if (!course) {
    throw new Error(`Course not found: ${courseIdOrSlug}`);
  }

  const downloadLinks = course.downloadLinks || [];
  const urls = downloadLinks.map(l => l.url).filter(u => u && u.startsWith('http'));

  if (urls.length === 0) {
    throw new Error(`Course "${course.title}" has no valid download URLs`);
  }

  // Find target worker URL
  let targetWorkerUrl = options.workerUrl?.replace(/\/+$/, '');
  if (!targetWorkerUrl) {
    const activeWorkers = await getActiveCourseWorkers();
    const ready = activeWorkers.find(w => w.status !== 'unreachable');
    if (ready) {
      targetWorkerUrl = ready.url;
    } else {
      targetWorkerUrl = 'http://localhost:8085';
    }
  }

  const payload: any = {
    title: course.title,
    slug: course.slug,
    urls,
    password: options.password || course.filePassword || 'www.downloadly.ir',
    upload: options.autoUpload !== false,
  };

  if (options.parentFolderId) {
    payload.parentFolderId = options.parentFolderId;
  }

  console.log(`[CourseService] Submitting course "${course.title}" (${urls.length} parts) to worker ${targetWorkerUrl}/api/process`);

  const resp = await fetch(`${targetWorkerUrl}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  const data = await resp.json() as any;

  if (!resp.ok && resp.status !== 202) {
    throw new Error(data.error || `Worker returned HTTP ${resp.status}`);
  }

  const jobId = data.jobId || `job_${Date.now()}`;

  // Update DB status to uploading
  await updateCourseDriveStatus(course.id, {
    driveStatus: 'uploading',
    driveCourseId: jobId,
    driveError: null,
  });

  return {
    success: true,
    jobId,
    message: data.message || `Course "${course.title}" queued for processing.`,
    workerUrl: targetWorkerUrl,
  };
}

/**
 * Cancels a job on the Go Course Worker.
 */
export async function cancelWorkerJob(jobId: string, workerUrl?: string): Promise<{ success: boolean; message: string }> {
  let targetWorkerUrl = workerUrl?.replace(/\/+$/, '') || 'http://localhost:8085';

  try {
    const resp = await fetch(`${targetWorkerUrl}/worker/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json() as any;
    return { success: true, message: data.message || 'Job cancelled' };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
}
