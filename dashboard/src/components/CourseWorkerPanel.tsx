import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  api,
  CourseItem,
  CourseLesson,
  CourseStatsResponse,
  CourseWorkerInfo,
  CourseProgressEvent,
} from '../api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type TabMode = 'catalog' | 'active' | 'player' | 'custom';

export default function CourseWorkerPanel() {
  const [tab, setTab] = useState<TabMode>('catalog');

  // Stats & Workers
  const [stats, setStats] = useState<CourseStatsResponse['stats'] | null>(null);
  const [workers, setWorkers] = useState<CourseWorkerInfo[]>([]);
  const [selectedWorkerUrl, setSelectedWorkerUrl] = useState<string>('http://localhost:8085');
  const [workerHealth, setWorkerHealth] = useState<{ online: boolean; disk?: any; activeCourses?: number }>({ online: false });
  const [refreshingWorkers, setRefreshingWorkers] = useState<boolean>(false);

  // Catalog State
  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [totalCourses, setTotalCourses] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedTopic, setSelectedTopic] = useState<string>('all');
  const [topics, setTopics] = useState<Array<{ name: string; count: number }>>([]);
  const [sortOrder, setSortOrder] = useState<string>('size');
  const [catalogLoading, setCatalogLoading] = useState<boolean>(false);

  // Active Job State
  const [activeJobId, setActiveJobId] = useState<string>('');
  const [activeJobTitle, setActiveJobTitle] = useState<string>('');
  const [activeJobCourse, setActiveJobCourse] = useState<CourseItem | null>(null);
  const [liveEvent, setLiveEvent] = useState<CourseProgressEvent | null>(null);
  const [liveLogs, setLiveLogs] = useState<Array<{ time: string; msg: string; type: 'info' | 'warn' | 'err' | 'success' }>>([]);
  const [isJobActive, setIsJobActive] = useState<boolean>(false);
  const [startingJob, setStartingJob] = useState<string | null>(null);

  // Video Watcher State
  const [watchingCourse, setWatchingCourse] = useState<CourseItem | null>(null);
  const [activeVideoIndex, setActiveVideoIndex] = useState<number>(1);
  const [videoLessons, setVideoLessons] = useState<CourseLesson[]>([]);
  const [materialZips, setMaterialZips] = useState<CourseLesson[]>([]);
  const [autoplayNext, setAutoplayNext] = useState<boolean>(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Custom URL Form State
  const [customUrlsText, setCustomUrlsText] = useState<string>('');
  const [customTitle, setCustomTitle] = useState<string>('');
  const [customPassword, setCustomPassword] = useState<string>('www.downloadly.ir');
  const [customUploadDrive, setCustomUploadDrive] = useState<boolean>(true);
  const [customParentFolder, setCustomParentFolder] = useState<string>('');
  const [customSubmitting, setCustomSubmitting] = useState<boolean>(false);

  // WebSocket / EventSource reference
  const wsRef = useRef<WebSocket | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Load stats and topics on mount
  const loadInitialData = useCallback(async () => {
    try {
      const [statsRes, topicsRes, workersRes] = await Promise.all([
        api.getCourseStats().catch(() => null),
        api.getCourseTopics().catch(() => null),
        api.getCourseWorkersStatus().catch(() => null),
      ]);
      if (statsRes?.success) setStats(statsRes.stats);
      if (topicsRes?.success) setTopics(topicsRes.topics);
      if (workersRes?.success && workersRes.workers.length > 0) {
        setWorkers(workersRes.workers);
        const active = workersRes.workers.find(w => w.status !== 'unreachable');
        if (active) setSelectedWorkerUrl(active.url);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  // Probe current selected worker health
  const probeWorker = useCallback(async (targetUrl: string) => {
    try {
      const clean = targetUrl.replace(/\/+$/, '');
      const resp = await fetch(`${clean}/worker/status`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const d = await resp.json();
        setWorkerHealth({
          online: true,
          disk: d.disk,
          activeCourses: d.activeCourses,
        });
        return;
      }
    } catch {
      // unreachable
    }
    setWorkerHealth({ online: false });
  }, []);

  useEffect(() => {
    probeWorker(selectedWorkerUrl);
    const id = setInterval(() => probeWorker(selectedWorkerUrl), 15000);
    return () => clearInterval(id);
  }, [selectedWorkerUrl, probeWorker]);

  // Fetch courses catalog
  const fetchCourses = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const res = await api.getCourses({
        page: currentPage,
        limit: 24,
        search: debouncedSearch || undefined,
        topic: selectedTopic !== 'all' ? selectedTopic : undefined,
        driveStatus: statusFilter !== 'all' ? statusFilter : undefined,
        sort: sortOrder,
      });
      if (res?.success) {
        setCourses(res.data);
        setTotalCourses(res.total);
        setTotalPages(res.totalPages);
      }
    } catch {
      // ignore
    } finally {
      setCatalogLoading(false);
    }
  }, [currentPage, debouncedSearch, selectedTopic, statusFilter, sortOrder]);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

  const addLog = (msg: string, type: 'info' | 'warn' | 'err' | 'success' = 'info') => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLiveLogs(prev => [...prev.slice(-250), { time, msg, type }]);
  };

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [liveLogs]);

  // Connect live streaming for active job
  const connectLiveUpdates = useCallback((jobId: string, workerUrl: string) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }

    const clean = workerUrl.replace(/\/+$/, '');
    const wsUrl = clean.replace(/^http/, 'ws') + `/ws/jobs/${encodeURIComponent(jobId)}`;

    addLog(`Connecting live WebSocket stream: ${wsUrl}`, 'info');

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        addLog(`WebSocket connection established for job ${jobId}`, 'success');
        setIsJobActive(true);
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as CourseProgressEvent;
          setLiveEvent(data);

          if (data.type === 'progress') {
            const phaseStr = (data.phase || '').toUpperCase();
            const pct = data.progressPercent ? `${data.progressPercent.toFixed(1)}%` : '';
            const spd = data.speedMBps ? `(${data.speedMBps.toFixed(2)} MB/s)` : '';
            addLog(`[${phaseStr}] ${pct} ${spd} ${data.message || ''}`, 'info');
          } else if (data.type === 'result') {
            if (data.success && data.uploaded) {
              addLog(`🎉 Job completed successfully! Uploaded to Drive: ${data.driveFolderUrl || ''}`, 'success');
              setIsJobActive(false);
              // Refresh catalog and stats
              fetchCourses();
              api.getCourseStats().then(s => s.success && setStats(s.stats)).catch(() => {});
            } else {
              const errTxt = data.error || 'Job failed';
              addLog(`❌ Job failed: ${errTxt}`, 'err');
              setIsJobActive(false);
              fetchCourses();
            }
          }
        } catch {
          // ignore parse error
        }
      };

      ws.onerror = () => {
        addLog(`WebSocket error, falling back to SSE stream...`, 'warn');
        fallbackToSSE(jobId, clean);
      };

      ws.onclose = () => {
        // Closed
      };
    } catch {
      fallbackToSSE(jobId, clean);
    }
  }, [fetchCourses]);

  const fallbackToSSE = (jobId: string, workerBase: string) => {
    const sseUrl = `${workerBase}/api/jobs/${encodeURIComponent(jobId)}/events`;
    addLog(`Listening via Server-Sent Events: ${sseUrl}`, 'info');
    try {
      const es = new EventSource(sseUrl);
      sseRef.current = es;

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as CourseProgressEvent;
          setLiveEvent(data);
          if (data.phase === 'completed' || data.phase === 'failed' || data.phase === 'cancelled') {
            es.close();
            setIsJobActive(false);
            fetchCourses();
          }
        } catch {}
      };

      es.onerror = () => {
        es.close();
      };
    } catch {}
  };

  // Start processing a catalog course
  const handleStartCatalogCourse = async (course: CourseItem) => {
    setStartingJob(course.id);
    addLog(`Initiating download & upload for "${course.title}"...`, 'info');
    try {
      const res = await api.processCourse(course.id, {
        workerUrl: selectedWorkerUrl,
      });
      if (res.success) {
        setActiveJobId(res.jobId);
        setActiveJobTitle(course.title);
        setActiveJobCourse(course);
        setIsJobActive(true);
        setTab('active');
        addLog(`Job submitted! Job ID: ${res.jobId}`, 'success');
        connectLiveUpdates(res.jobId, res.workerUrl || selectedWorkerUrl);
        fetchCourses();
      }
    } catch (e: any) {
      addLog(`Failed to start job: ${e.message}`, 'err');
      alert(`Could not start course job: ${e.message}`);
    } finally {
      setStartingJob(null);
    }
  };

  // Submit custom URLs
  const handleCustomSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const urls = customUrlsText
      .split('\n')
      .map(u => u.trim())
      .filter(u => u.startsWith('http'));

    if (urls.length === 0) {
      alert('Please enter at least one valid HTTP/HTTPS archive URL.');
      return;
    }

    setCustomSubmitting(true);
    addLog(`Submitting custom job with ${urls.length} download links...`, 'info');
    try {
      const res = await api.processCustomCourse({
        urls,
        title: customTitle.trim() || undefined,
        password: customPassword.trim() || undefined,
        upload: customUploadDrive,
        parentFolderId: customParentFolder.trim() || undefined,
        workerUrl: selectedWorkerUrl,
      });

      if (res.jobId || res.success) {
        const jId = res.jobId || `job_${Date.now()}`;
        const title = res.title || customTitle || 'Custom Course';
        setActiveJobId(jId);
        setActiveJobTitle(title);
        setActiveJobCourse(null);
        setIsJobActive(true);
        setTab('active');
        addLog(`Custom job started: ${title} (${jId})`, 'success');
        connectLiveUpdates(jId, res.workerUrl || selectedWorkerUrl);
      }
    } catch (err: any) {
      addLog(`Error submitting custom course: ${err.message}`, 'err');
      alert(`Submission error: ${err.message}`);
    } finally {
      setCustomSubmitting(false);
    }
  };

  // Cancel in-flight job
  const handleCancelJob = async () => {
    if (!activeJobId) return;
    if (!confirm(`Are you sure you want to cancel job ${activeJobId}? This will abort downloading/uploading and purge temporary files.`)) {
      return;
    }
    addLog(`Sending abort request for job ${activeJobId}...`, 'warn');
    try {
      await api.cancelCourseWorkerJob(activeJobId, selectedWorkerUrl);
      addLog(`Job ${activeJobId} cancelled by user.`, 'warn');
      setIsJobActive(false);
      fetchCourses();
    } catch (e: any) {
      addLog(`Cancel error: ${e.message}`, 'err');
    }
  };

  // Open course player
  const handleWatchCourse = (course: CourseItem) => {
    setWatchingCourse(course);
    const videos = (course.driveVideos || []).filter(v => v.fileName.match(/\.(mp4|mkv|webm|mov|avi|flv|wmv)$/i));
    const materials = (course.driveVideos || []).filter(v => v.fileName.match(/\.(zip|rar|7z|tar|gz|bz2)$/i) || v.fileName.includes('_Materials'));

    setVideoLessons(videos);
    setMaterialZips(materials);

    if (videos.length > 0) {
      setActiveVideoIndex(videos[0].index);
    }
    setTab('player');
  };

  // Switch video lesson
  const currentVideoLesson = videoLessons.find(v => v.index === activeVideoIndex) || videoLessons[0];

  const handleLessonEnded = () => {
    if (!autoplayNext) return;
    const currIdx = videoLessons.findIndex(v => v.index === activeVideoIndex);
    if (currIdx >= 0 && currIdx < videoLessons.length - 1) {
      setActiveVideoIndex(videoLessons[currIdx + 1].index);
    }
  };

  // Diagnostics reason deduction
  const deduceFailureDiagnosis = (errText: string) => {
    const lower = errText.toLowerCase();
    if (lower.includes('404') || lower.includes('not found')) {
      return {
        title: 'CDN Archive Link Dead (HTTP 404)',
        advice: 'The download source URL is broken or removed by the host. Check if Downloadly updated their download parts or use alternative mirror links.',
        severity: 'critical',
      };
    }
    if (lower.includes('502') || lower.includes('503') || lower.includes('bad gateway') || lower.includes('timeout')) {
      return {
        title: 'CDN Connection or Gateway Timeout (502/504)',
        advice: 'The download server or intermediate proxy timed out. Retry with smaller concurrency or check worker network reachability.',
        severity: 'warning',
      };
    }
    if (lower.includes('password') || lower.includes('crc') || lower.includes('bad password') || lower.includes('header checksum')) {
      return {
        title: 'Extraction Password Mismatch',
        advice: 'The archive password failed. Verify the course password (default: www.downloadly.ir). You can override the password in Custom URL tab.',
        severity: 'warning',
      };
    }
    if (lower.includes('enospc') || lower.includes('disk') || lower.includes('space')) {
      return {
        title: 'Insufficient Free Disk Space (< 5GB threshold)',
        advice: 'The worker disk ran out of space. Cancel stale jobs or ensure the worker storage volume has at least 15-30 GB available for large extractions.',
        severity: 'critical',
      };
    }
    if (lower.includes('ratelimit') || lower.includes('429') || lower.includes('userRateLimitExceeded')) {
      return {
        title: 'Google Drive API Rate Limit Exceeded (HTTP 429)',
        advice: 'Google Drive rate limit reached. The worker includes exponential backoff; waiting 30-60 seconds before retrying usually resolves this.',
        severity: 'warning',
      };
    }
    return {
      title: 'Course Processing Interrupted',
      advice: errText || 'An unexpected pipeline error occurred. Review the live event logs below for details.',
      severity: 'info',
    };
  };

  return (
    <div className="space-y-4 font-mono text-xs">
      {/* ── TOP METRICS & WORKER HEALTH BAR ───────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Card className="p-3 bg-card border-border">
          <p className="text-[10px] uppercase text-muted-foreground font-bold">Total Catalog</p>
          <p className="text-lg sm:text-xl font-bold text-foreground">
            {stats ? stats.total.toLocaleString() : '14,593'}
          </p>
          <span className="text-[9px] text-muted-foreground">in Neon DB</span>
        </Card>

        <Card className="p-3 bg-card border-border border-emerald-500/30">
          <p className="text-[10px] uppercase text-emerald-500 font-bold flex items-center gap-1">
            <span>▶️</span> Ready to Watch
          </p>
          <p className="text-lg sm:text-xl font-bold text-emerald-400">
            {stats ? stats.completed.toLocaleString() : '915'}
          </p>
          <span className="text-[9px] text-muted-foreground">Uploaded to Drive</span>
        </Card>

        <Card className="p-3 bg-card border-border border-blue-500/30">
          <p className="text-[10px] uppercase text-blue-400 font-bold flex items-center gap-1">
            <span>⚡</span> Active / Uploading
          </p>
          <p className="text-lg sm:text-xl font-bold text-blue-300">
            {stats ? stats.uploading.toLocaleString() : '0'}
          </p>
          <span className="text-[9px] text-muted-foreground">Processing now</span>
        </Card>

        <Card className="p-3 bg-card border-border">
          <p className="text-[10px] uppercase text-amber-500 font-bold">Pending Upload</p>
          <p className="text-lg sm:text-xl font-bold text-amber-400">
            {stats ? stats.pending.toLocaleString() : '13,678'}
          </p>
          <span className="text-[9px] text-muted-foreground">Ready to queue</span>
        </Card>

        <Card className="p-3 bg-card border-border">
          <p className="text-[10px] uppercase text-muted-foreground font-bold">Stored Volume</p>
          <p className="text-lg sm:text-xl font-bold text-foreground">
            {stats && stats.totalSizeBytes ? `${(stats.totalSizeBytes / (1024 ** 4)).toFixed(1)} TB` : '24.2 TB'}
          </p>
          <span className="text-[9px] text-muted-foreground">Archive content</span>
        </Card>

        {/* Worker Selector & Probe */}
        <Card className="p-3 bg-card border-border flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold text-muted-foreground">Engine</span>
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${
              workerHealth.online ? 'border-emerald-500 text-emerald-400 font-bold' : 'border-destructive text-destructive'
            }`}>
              {workerHealth.online ? '● ONLINE' : '○ OFFLINE'}
            </Badge>
          </div>
          <div className="mt-1">
            <select
              value={selectedWorkerUrl}
              onChange={(e) => {
                setSelectedWorkerUrl(e.target.value);
                probeWorker(e.target.value);
              }}
              className="w-full bg-secondary border border-border rounded px-1.5 py-0.5 text-[10px] font-mono text-foreground focus:outline-none"
            >
              <option value="http://localhost:8085">Local Worker (:8085)</option>
              {workers.map(w => (
                <option key={w.url} value={w.url}>
                  {w.source === 'pool' ? `Worker ${w.workerId}` : w.url} {w.status === 'busy' ? '(busy)' : ''}
                </option>
              ))}
            </select>
          </div>
          {workerHealth.disk && (
            <span className="text-[9px] text-muted-foreground mt-1 truncate">
              Disk: {workerHealth.disk.freeGB}GB free / {workerHealth.disk.totalGB}GB
            </span>
          )}
        </Card>
      </div>

      {/* ── NAVIGATION TABS ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-center gap-1.5">
          <Button
            variant={tab === 'catalog' ? 'default' : 'outline'}
            size="xs"
            onClick={() => setTab('catalog')}
            className="text-[11px] uppercase font-bold tracking-wider"
          >
            <span>📚</span>
            <span>Course Catalog</span>
            <Badge variant="secondary" className="ml-1 text-[9px] px-1 py-0">{totalCourses}</Badge>
          </Button>

          <Button
            variant={tab === 'active' ? 'default' : 'outline'}
            size="xs"
            onClick={() => setTab('active')}
            className={`text-[11px] uppercase font-bold tracking-wider relative ${
              isJobActive ? 'border-blue-500 text-blue-400 animate-pulse' : ''
            }`}
          >
            <span>⚡</span>
            <span>Live Stream & Diagnostics</span>
            {isJobActive && (
              <span className="w-2 h-2 rounded-full bg-blue-500 inline-block ml-1"></span>
            )}
          </Button>

          <Button
            variant={tab === 'player' ? 'default' : 'outline'}
            size="xs"
            onClick={() => setTab('player')}
            className={`text-[11px] uppercase font-bold tracking-wider ${
              watchingCourse ? 'border-emerald-500/60' : ''
            }`}
          >
            <span>▶️</span>
            <span>Watch & Lessons</span>
            {watchingCourse && (
              <Badge variant="secondary" className="ml-1 text-[9px] px-1 py-0 truncate max-w-[90px]">
                {watchingCourse.title}
              </Badge>
            )}
          </Button>

          <Button
            variant={tab === 'custom' ? 'default' : 'outline'}
            size="xs"
            onClick={() => setTab('custom')}
            className="text-[11px] uppercase font-bold tracking-wider"
          >
            <span>🔗</span>
            <span>Custom URL Importer</span>
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            onClick={async () => {
              setRefreshingWorkers(true);
              await Promise.all([loadInitialData(), fetchCourses(), probeWorker(selectedWorkerUrl)]);
              setRefreshingWorkers(false);
            }}
            disabled={refreshingWorkers}
            className="text-[10px] font-mono"
          >
            <span>🔄</span>
            <span>{refreshingWorkers ? 'Refreshing...' : 'Refresh'}</span>
          </Button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          TAB 1: CATALOG & SELECTOR
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'catalog' && (
        <div className="space-y-3">
          {/* Filters Bar */}
          <div className="flex flex-col sm:flex-row gap-2 items-center justify-between bg-card p-2.5 border border-border">
            <div className="flex-1 w-full sm:w-auto relative">
              <span className="absolute inset-y-0 left-2.5 flex items-center text-muted-foreground text-xs">🔍</span>
              <Input
                type="text"
                placeholder="Search courses by title, slug, or topic (e.g. Python, Docker, React, Machine Learning)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-6 text-xs h-8 bg-secondary"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute inset-y-0 right-2.5 flex items-center text-muted-foreground hover:text-foreground text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <select
                value={selectedTopic}
                onChange={(e) => {
                  setSelectedTopic(e.target.value);
                  setCurrentPage(1);
                }}
                className="bg-secondary border border-border rounded px-2 py-1 text-xs font-mono text-foreground focus:outline-none"
              >
                <option value="all">All Topics ({totalCourses})</option>
                {topics.map(t => (
                  <option key={t.name} value={t.name}>{t.name} ({t.count})</option>
                ))}
              </select>

              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className="bg-secondary border border-border rounded px-2 py-1 text-xs font-mono text-foreground focus:outline-none"
              >
                <option value="all">Status: All</option>
                <option value="completed">Status: Ready to Watch</option>
                <option value="uploading">Status: In Progress</option>
                <option value="pending">Status: Pending Upload</option>
                <option value="failed">Status: Failed / Retry</option>
              </select>

              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                className="bg-secondary border border-border rounded px-2 py-1 text-xs font-mono text-foreground focus:outline-none"
              >
                <option value="size">Sort: Size (Largest)</option>
                <option value="newest">Sort: Newest</option>
                <option value="rating">Sort: Highest Rating</option>
                <option value="title">Sort: Title (A-Z)</option>
              </select>
            </div>
          </div>

          {/* Quick Filter Status Pills */}
          <div className="flex flex-wrap items-center gap-1 text-[10px]">
            <span className="text-muted-foreground uppercase font-bold mr-1">Filter:</span>
            {[
              { id: 'all', label: 'All Courses' },
              { id: 'completed', label: '▶️ Completed (Watch)' },
              { id: 'uploading', label: '⚡ Active' },
              { id: 'pending', label: '⏳ Pending' },
              { id: 'failed', label: '⚠️ Failed' },
            ].map(pill => (
              <button
                key={pill.id}
                onClick={() => {
                  setStatusFilter(pill.id);
                  setCurrentPage(1);
                }}
                className={`px-2 py-0.5 rounded border transition-colors ${
                  statusFilter === pill.id
                    ? 'bg-foreground text-background border-foreground font-bold'
                    : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
                }`}
              >
                {pill.label}
              </button>
            ))}
          </div>

          {/* Courses Grid */}
          {catalogLoading ? (
            <div className="flex items-center justify-center p-16 text-muted-foreground">
              <span>Loading course catalog from Neon DB...</span>
            </div>
          ) : courses.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground bg-card border border-border">
              <p className="text-sm font-bold">No courses match your search criteria.</p>
              <p className="text-xs mt-1">Try broadening your search term or selecting "All Topics".</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {courses.map(course => {
                const isCompleted = course.driveStatus === 'completed';
                const isUploading = course.driveStatus === 'uploading';
                const isFailed = course.driveStatus === 'failed';
                const sizeText = course.calculatedSizeBytes
                  ? `${(course.calculatedSizeBytes / (1024 ** 3)).toFixed(1)} GB`
                  : (course.statedSizeText || 'Size unknown');

                return (
                  <Card
                    key={course.id}
                    className={`p-3.5 bg-card border transition-all flex flex-col justify-between ${
                      isCompleted
                        ? 'border-emerald-500/40 hover:border-emerald-500/70'
                        : isUploading
                        ? 'border-blue-500/50 bg-blue-950/10'
                        : isFailed
                        ? 'border-destructive/40'
                        : 'border-border hover:border-foreground/30'
                    }`}
                  >
                    <div className="space-y-2">
                      {/* Status + Topic Badge */}
                      <div className="flex items-center justify-between gap-1">
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 truncate max-w-[160px]">
                          {course.primaryCategory || course.topic || 'General'}
                        </Badge>

                        <Badge
                          variant="outline"
                          className={`text-[9px] px-1.5 py-0 font-bold uppercase ${
                            isCompleted
                              ? 'border-emerald-500 text-emerald-400 bg-emerald-950/20'
                              : isUploading
                              ? 'border-blue-400 text-blue-300 animate-pulse bg-blue-950/20'
                              : isFailed
                              ? 'border-destructive text-destructive bg-destructive/10'
                              : 'border-border text-muted-foreground'
                          }`}
                        >
                          {isCompleted ? '✓ Completed' : isUploading ? '⚡ In Progress' : isFailed ? '✕ Failed' : 'Pending'}
                        </Badge>
                      </div>

                      {/* Course Title */}
                      <h4
                        className="font-bold text-foreground text-xs leading-snug line-clamp-2"
                        title={course.title}
                      >
                        {course.title}
                      </h4>

                      {/* Specs / Meta */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                        <span>📦 {sizeText}</span>
                        <span>•</span>
                        <span>📁 {course.downloadLinksCount} Parts</span>
                        {course.rating?.score && (
                          <>
                            <span>•</span>
                            <span className="text-amber-400 font-bold">★ {course.rating.score.toFixed(1)}</span>
                          </>
                        )}
                        {course.driveVideosCount > 0 && (
                          <>
                            <span>•</span>
                            <span className="text-emerald-400">🎬 {course.driveVideosCount} Videos</span>
                          </>
                        )}
                      </div>

                      {/* Error excerpt if failed */}
                      {isFailed && course.driveError && (
                        <div className="p-1.5 bg-destructive/10 border border-destructive/30 rounded text-[9px] text-destructive line-clamp-2">
                          [Error]: {course.driveError}
                        </div>
                      )}
                    </div>

                    {/* Action Buttons */}
                    <div className="pt-3 mt-2 border-t border-border flex items-center justify-between gap-1.5">
                      {isCompleted ? (
                        <>
                          <Button
                            size="xs"
                            variant="default"
                            onClick={() => handleWatchCourse(course)}
                            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold uppercase"
                          >
                            <span>▶️</span>
                            <span>Watch Lessons</span>
                          </Button>

                          {course.driveFolderId && (
                            <a
                              href={`https://drive.google.com/drive/folders/${course.driveFolderId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="px-2 py-1 bg-secondary border border-border rounded text-[10px] hover:text-foreground text-muted-foreground flex items-center gap-1"
                              title="Open in Google Drive"
                            >
                              <span>📂</span>
                            </a>
                          )}
                        </>
                      ) : isUploading ? (
                        <>
                          <Button
                            size="xs"
                            variant="default"
                            onClick={() => {
                              setActiveJobId(course.driveCourseId || course.id);
                              setActiveJobTitle(course.title);
                              setActiveJobCourse(course);
                              setTab('active');
                              if (course.driveCourseId) {
                                connectLiveUpdates(course.driveCourseId, selectedWorkerUrl);
                              }
                            }}
                            className="w-full bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold uppercase animate-pulse"
                          >
                            <span>📡</span>
                            <span>View Live Stream</span>
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="xs"
                            variant="default"
                            disabled={startingJob === course.id}
                            onClick={() => handleStartCatalogCourse(course)}
                            className="w-full text-[10px] font-bold uppercase tracking-wider"
                          >
                            <span>{startingJob === course.id ? '⏳' : '⚡'}</span>
                            <span>{startingJob === course.id ? 'Starting...' : 'Download & Upload'}</span>
                          </Button>
                        </>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between bg-card p-2 border border-border text-xs">
              <div className="text-muted-foreground text-[10px]">
                Page {currentPage} of {totalPages} ({totalCourses.toLocaleString()} courses)
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  className="font-mono text-[10px]"
                >
                  ◀ Prev
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  className="font-mono text-[10px]"
                >
                  Next ▶
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB 2: LIVE STREAM & DIAGNOSTICS
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'active' && (
        <div className="space-y-4">
          {/* Active Job Header Card */}
          <Card className="p-4 bg-card border-border space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-border">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] font-bold">
                    JOB ID: {activeJobId || 'None Selected'}
                  </Badge>
                  {isJobActive && (
                    <Badge variant="default" className="bg-blue-600 text-white text-[9px] animate-pulse">
                      ● RUNNING
                    </Badge>
                  )}
                  {liveEvent?.phase === 'completed' && (
                    <Badge variant="default" className="bg-emerald-600 text-white text-[9px]">
                      ✓ COMPLETED
                    </Badge>
                  )}
                  {liveEvent?.phase === 'failed' && (
                    <Badge variant="destructive" className="text-[9px]">
                      ✕ FAILED
                    </Badge>
                  )}
                </div>
                <h3 className="text-sm sm:text-base font-bold text-foreground mt-1">
                  {activeJobTitle || (activeJobCourse ? activeJobCourse.title : 'No active course running')}
                </h3>
              </div>

              <div className="flex items-center gap-2">
                {isJobActive && (
                  <Button
                    variant="destructive"
                    size="xs"
                    onClick={handleCancelJob}
                    className="text-[10px] font-bold uppercase"
                  >
                    <span>🛑</span>
                    <span>Abort Job</span>
                  </Button>
                )}
                {liveEvent?.phase === 'completed' && activeJobCourse && (
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => handleWatchCourse(activeJobCourse)}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold uppercase"
                  >
                    <span>▶️</span>
                    <span>Watch Now</span>
                  </Button>
                )}
              </div>
            </div>

            {/* 6-Stage Progress Stepper */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground">
                <span className="uppercase text-foreground">
                  Current Phase: <span className="text-blue-400 font-mono">{liveEvent?.phase?.toUpperCase() || (isJobActive ? 'INITIALIZING' : 'IDLE')}</span>
                </span>
                <span>
                  {liveEvent?.progressPercent !== undefined ? `${liveEvent.progressPercent.toFixed(1)}%` : (isJobActive ? '0%' : '')}
                  {liveEvent?.speedMBps ? ` • ${liveEvent.speedMBps.toFixed(2)} MB/s` : ''}
                </span>
              </div>

              {/* Progress Bar */}
              <div className="h-2.5 bg-secondary rounded overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${
                    liveEvent?.phase === 'completed'
                      ? 'bg-emerald-500'
                      : liveEvent?.phase === 'failed'
                      ? 'bg-destructive'
                      : 'bg-blue-500'
                  }`}
                  style={{ width: `${Math.min(100, liveEvent?.progressPercent || (isJobActive ? 5 : 0))}%` }}
                />
              </div>

              {/* 6 Stage Stepper Pills */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 pt-2 text-[10px] text-center">
                {[
                  { key: 'downloading', label: '1. Download Parts' },
                  { key: 'extracting', label: '2. Extract Archive' },
                  { key: 'reclaiming', label: '3. Reclaim Disk' },
                  { key: 'separating', label: '4. Split Zips' },
                  { key: 'uploading', label: '5. Drive Upload' },
                  { key: 'completed', label: '6. Ready' },
                ].map((st, i) => {
                  const currentPhase = liveEvent?.phase || '';
                  const phaseOrder = ['pending', 'downloading', 'extracting', 'reclaiming', 'separating', 'zipping', 'uploading', 'completed'];
                  const currIdx = phaseOrder.indexOf(currentPhase);
                  const thisIdx = phaseOrder.indexOf(st.key);
                  const isDone = currIdx > thisIdx;
                  const isCurrent = currentPhase === st.key || (st.key === 'separating' && currentPhase === 'zipping');

                  return (
                    <div
                      key={st.key}
                      className={`p-1.5 rounded border ${
                        isDone
                          ? 'bg-emerald-950/20 border-emerald-500/50 text-emerald-400 font-bold'
                          : isCurrent
                          ? 'bg-blue-950/30 border-blue-500 text-blue-300 font-bold animate-pulse'
                          : 'bg-secondary/40 border-border text-muted-foreground'
                      }`}
                    >
                      {st.label}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Diagnostics Error Alert (Why Something Went Wrong) */}
            {liveEvent?.phase === 'failed' && (
              (() => {
                const diag = deduceFailureDiagnosis(liveEvent.error || 'Unknown failure');
                return (
                  <div className="p-3 bg-destructive/15 border border-destructive rounded space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-base">⚠️</span>
                      <h4 className="font-bold text-destructive text-xs uppercase tracking-wide">
                        [Root Cause Diagnostic]: {diag.title}
                      </h4>
                    </div>
                    <p className="text-[11px] text-foreground font-sans">{diag.advice}</p>
                    {liveEvent.error && (
                      <pre className="p-2 bg-black/40 rounded text-[10px] text-destructive-foreground font-mono overflow-x-auto whitespace-pre-wrap">
                        {liveEvent.error}
                      </pre>
                    )}
                    <div className="flex items-center gap-2 pt-1">
                      {activeJobCourse && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => handleStartCatalogCourse(activeJobCourse)}
                          className="text-[10px] font-bold uppercase"
                        >
                          <span>🔄</span>
                          <span>Retry Course Job</span>
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setTab('catalog')}
                        className="text-[10px]"
                      >
                        Return to Catalog
                      </Button>
                    </div>
                  </div>
                );
              })()
            )}

            {/* Google Drive Links upon completion */}
            {liveEvent?.phase === 'completed' && (
              <div className="p-3 bg-emerald-950/20 border border-emerald-500/40 rounded space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-emerald-400 text-xs flex items-center gap-1.5">
                    <span>🎉</span> Course Uploaded & Ready!
                  </span>
                  {liveEvent.driveFolderUrl && (
                    <a
                      href={liveEvent.driveFolderUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[10px] font-bold uppercase flex items-center gap-1"
                    >
                      <span>📂</span> Open Drive Folder
                    </a>
                  )}
                </div>
                {liveEvent.driveFiles && liveEvent.driveFiles.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    Uploaded {liveEvent.driveFiles.length} files to Google Drive. Click below to stream in player.
                  </p>
                )}
              </div>
            )}
          </Card>

          {/* Parts & Uploaded Files Live Breakdown */}
          {liveEvent?.parts && liveEvent.parts.length > 0 && (
            <Card className="p-3 bg-card border-border space-y-2">
              <h4 className="font-bold text-foreground text-xs uppercase flex items-center justify-between">
                <span>Archive Parts Breakdown ({liveEvent.completedParts || 0} / {liveEvent.totalParts || liveEvent.parts.length} completed)</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {liveEvent.parts.map(p => (
                  <div
                    key={p.partIndex}
                    className="p-2 bg-secondary border border-border rounded text-[10px] space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold truncate max-w-[160px]">{p.fileName}</span>
                      <Badge
                        variant="outline"
                        className={`text-[8px] px-1 py-0 ${
                          p.status === 'completed' ? 'border-emerald-500 text-emerald-400 font-bold' :
                          p.status === 'downloading' ? 'border-blue-500 text-blue-300 animate-pulse' :
                          p.status === 'failed' ? 'border-destructive text-destructive' : 'text-muted-foreground'
                        }`}
                      >
                        {p.status}
                      </Badge>
                    </div>
                    <div className="h-1 bg-background rounded overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all duration-300"
                        style={{ width: `${p.percent}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground">
                      <span>{p.percent.toFixed(1)}%</span>
                      {p.speedBytesSec > 0 && <span>{(p.speedBytesSec / (1024 * 1024)).toFixed(1)} MB/s</span>}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Real-time Event Log Terminal */}
          <Card className="p-3 bg-card border-border space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-foreground text-xs uppercase flex items-center gap-1.5">
                <span>💻</span> Pipeline Event Stream
              </h4>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setLiveLogs([])}
                className="text-[9px] h-6 px-2 text-muted-foreground hover:text-foreground"
              >
                Clear Log
              </Button>
            </div>

            <div
              ref={logContainerRef}
              className="h-44 bg-black/70 border border-border rounded p-2.5 overflow-y-auto space-y-1 text-[10px] font-mono"
            >
              {liveLogs.length === 0 ? (
                <div className="text-muted-foreground italic">Waiting for events...</div>
              ) : (
                liveLogs.map((l, i) => (
                  <div key={i} className="leading-tight flex items-start gap-1.5">
                    <span className="text-muted-foreground select-none">[{l.time}]</span>
                    <span className={
                      l.type === 'err' ? 'text-destructive font-bold' :
                      l.type === 'warn' ? 'text-amber-400' :
                      l.type === 'success' ? 'text-emerald-400 font-bold' :
                      'text-foreground'
                    }>
                      {l.msg}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB 3: VIDEO PLAYER & LESSON WATCHER
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'player' && (
        <div className="space-y-4">
          {!watchingCourse ? (
            <Card className="p-12 text-center text-muted-foreground bg-card border-border space-y-3">
              <span className="text-3xl">🎬</span>
              <p className="font-bold text-sm text-foreground">No completed course selected to watch.</p>
              <p className="text-xs">Select any course with "Ready to Watch" status in the Catalog to view lessons.</p>
              <Button
                variant="default"
                size="xs"
                onClick={() => {
                  setStatusFilter('completed');
                  setTab('catalog');
                }}
                className="text-xs uppercase font-bold"
              >
                Browse Completed Courses
              </Button>
            </Card>
          ) : (
            <div className="space-y-3">
              {/* Course Header Banner */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-card border border-border rounded">
                <div>
                  <Badge variant="outline" className="text-[9px] border-emerald-500 text-emerald-400 font-bold mb-1">
                    ✓ COMPLETED • READY TO STREAM
                  </Badge>
                  <h3 className="text-base font-bold text-foreground line-clamp-1">{watchingCourse.title}</h3>
                  <p className="text-[10px] text-muted-foreground">
                    {videoLessons.length} Video Lessons • {materialZips.length} Material Packages
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {watchingCourse.driveFolderId && (
                    <a
                      href={`https://drive.google.com/drive/folders/${watchingCourse.driveFolderId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2.5 py-1.5 bg-secondary border border-border rounded text-[10px] font-bold text-foreground hover:bg-foreground hover:text-background flex items-center gap-1.5 transition-colors"
                    >
                      <span>📂</span> Open Drive Folder
                    </a>
                  )}
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setTab('catalog')}
                    className="text-[10px]"
                  >
                    Back to Catalog
                  </Button>
                </div>
              </div>

              {/* Main Player & Curriculum Split */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Left (2 Cols): Embedded Video Player */}
                <div className="lg:col-span-2 space-y-2">
                  <Card className="p-2 bg-black border-border overflow-hidden">
                    {currentVideoLesson ? (
                      <div className="relative aspect-video bg-black flex items-center justify-center">
                        <video
                          ref={videoRef}
                          key={currentVideoLesson.driveFileId || currentVideoLesson.index}
                          controls
                          autoPlay
                          onEnded={handleLessonEnded}
                          className="w-full h-full object-contain"
                          src={
                            currentVideoLesson.driveFileId
                              ? `/api/courses/${watchingCourse.id}/stream/${currentVideoLesson.index}`
                              : undefined
                          }
                        >
                          Your browser does not support HTML5 video playback.
                        </video>
                      </div>
                    ) : (
                      <div className="aspect-video flex items-center justify-center text-muted-foreground">
                        No playable video selected.
                      </div>
                    )}

                    <div className="p-2 flex items-center justify-between text-xs">
                      <div className="truncate font-bold text-foreground max-w-[320px]">
                        Lesson {currentVideoLesson?.index}: {currentVideoLesson?.fileName || 'Video'}
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={autoplayNext}
                            onChange={(e) => setAutoplayNext(e.target.checked)}
                            className="rounded border-border"
                          />
                          <span>Auto-play next</span>
                        </label>
                        {currentVideoLesson?.driveViewLink && (
                          <a
                            href={currentVideoLesson.driveViewLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[10px] text-blue-400 hover:underline"
                          >
                            [Direct Drive Link]
                          </a>
                        )}
                      </div>
                    </div>
                  </Card>
                </div>

                {/* Right (1 Col): Lessons Playlist & Materials */}
                <div className="space-y-3">
                  <Card className="p-3 bg-card border-border flex flex-col h-[460px]">
                    <h4 className="font-bold text-foreground text-xs uppercase pb-2 border-b border-border flex items-center justify-between">
                      <span>Curriculum Playlist</span>
                      <span className="text-muted-foreground text-[10px]">{videoLessons.length} lessons</span>
                    </h4>

                    {/* Scrollable lessons list */}
                    <div className="flex-1 overflow-y-auto space-y-1 py-2 pr-1">
                      {videoLessons.map(lesson => {
                        const isSelected = lesson.index === activeVideoIndex;
                        return (
                          <button
                            key={lesson.index}
                            onClick={() => setActiveVideoIndex(lesson.index)}
                            className={`w-full text-left p-2 rounded text-[11px] transition-colors flex items-start gap-2 ${
                              isSelected
                                ? 'bg-emerald-600 text-white font-bold'
                                : 'bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary'
                            }`}
                          >
                            <span className="text-xs">{isSelected ? '▶' : '○'}</span>
                            <div className="flex-1 truncate">
                              <p className="truncate">{lesson.fileName}</p>
                              <span className="text-[9px] opacity-80">{lesson.sizeMB} MB</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Downloadable Materials Sub-section */}
                    {materialZips.length > 0 && (
                      <div className="pt-2 border-t border-border mt-auto">
                        <p className="text-[10px] font-bold uppercase text-muted-foreground mb-1">
                          📦 Downloadable Materials:
                        </p>
                        <div className="space-y-1 max-h-24 overflow-y-auto">
                          {materialZips.map(m => (
                            <div
                              key={m.index}
                              className="flex items-center justify-between p-1 bg-secondary rounded text-[10px]"
                            >
                              <span className="truncate max-w-[140px]">{m.fileName}</span>
                              {m.driveViewLink ? (
                                <a
                                  href={m.driveViewLink}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-blue-400 hover:underline"
                                >
                                  Download
                                </a>
                              ) : (
                                <span className="text-muted-foreground">{m.sizeMB} MB</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </Card>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB 4: CUSTOM URL IMPORTER
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'custom' && (
        <Card className="p-4 bg-card border-border max-w-2xl mx-auto space-y-4">
          <div>
            <CardTitle className="text-sm font-bold uppercase text-foreground">
              Manual Course Downloader & Uploader
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Paste archive URLs (RAR, ZIP, 7Z parts) from Downloadly or any direct CDN to execute the complete pipeline.
            </CardDescription>
          </div>

          <form onSubmit={handleCustomSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold text-muted-foreground">
                Archive Part URLs (One URL per line) *
              </label>
              <textarea
                rows={5}
                required
                value={customUrlsText}
                onChange={(e) => setCustomUrlsText(e.target.value)}
                placeholder="https://example.com/Course_Title.part1.rar&#10;https://example.com/Course_Title.part2.rar"
                className="w-full bg-secondary border border-border rounded p-2 text-xs font-mono text-foreground focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-muted-foreground">
                  Course Title (Optional, auto-deduced if empty)
                </label>
                <Input
                  type="text"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="e.g. Master React and TypeScript 2026"
                  className="text-xs h-8 bg-secondary"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-muted-foreground">
                  Extraction Password
                </label>
                <Input
                  type="text"
                  value={customPassword}
                  onChange={(e) => setCustomPassword(e.target.value)}
                  placeholder="www.downloadly.ir"
                  className="text-xs h-8 bg-secondary"
                />
              </div>
            </div>

            <div className="flex items-center gap-4 pt-1">
              <label className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={customUploadDrive}
                  onChange={(e) => setCustomUploadDrive(e.target.checked)}
                  className="rounded border-border"
                />
                <span>Auto-upload to Google Drive</span>
              </label>
            </div>

            <Button
              type="submit"
              disabled={customSubmitting}
              className="w-full py-2.5 text-xs font-bold uppercase tracking-wider"
            >
              {customSubmitting ? 'Starting...' : '⚡ Process Course & Stream Live'}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
