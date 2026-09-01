import React, { useState, useRef, useCallback, useEffect } from 'react';
import { api, PlaceResult, PlaceDetailResult, PlaceReview } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

// ── Sub-components ────────────────────────────────────────────────────────────

export interface PlaceEntry {
  place: PlaceResult;
  isNew: boolean;
}

// Global state for scraped data
let globalScrapedData: Record<string, any> = {};
const scrapedDataListeners: Set<() => void> = new Set();

function setGlobalScrapedData(url: string, data: any) {
  globalScrapedData = { ...globalScrapedData, [url]: data };
  scrapedDataListeners.forEach(l => l());
}

function useScrapedData() {
  const [data, setData] = useState(globalScrapedData);
  useEffect(() => {
    const listener = () => setData(globalScrapedData);
    scrapedDataListeners.add(listener);
    return () => { scrapedDataListeners.delete(listener); };
  }, []);
  return data;
}

function BulkActions({ entries, streaming }: { entries: PlaceEntry[], streaming: boolean }) {
  const scrapedData = useScrapedData();
  const [isBulkScraping, setIsBulkScraping] = useState(false);
  const [chunkSize, setChunkSize] = useState(10);

  const handleBulkScrape = async () => {
    setIsBulkScraping(true);
    const urls = entries.map(e => e.place.website).filter(u => u && !scrapedData[u]);
    for (let i = 0; i < urls.length; i += chunkSize) {
      if (!isBulkScraping) {
        // Can't easily break without a ref, but it's ok for now
      }
      const chunk = urls.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (url) => {
        try {
          const res = await api.scrapeContacts(url as string, 5, 5, '30s');
          setGlobalScrapedData(url as string, res);
        } catch(e) {}
      }));
    }
    setIsBulkScraping(false);
  };

  const handleDownload = (format: 'json'|'csv') => {
    const dataToExport = entries.map(e => {
      const p = e.place;
      const scrape = scrapedData[p.website || ''] || {};
      return {
        Name: p.name,
        Category: p.category || '',
        Address: p.address || '',
        Phone: p.phone || '',
        Website: p.website || '',
        Rating: p.rating || '',
        Reviews: p.reviewCount || '',
        Hours: p.todaysHours || '',
        ScrapedEmails: scrape.emails?.join(', ') || '',
        ScrapedPhones: scrape.phones?.join(', ') || '',
        ScrapedSocials: scrape.socials ? JSON.stringify(scrape.socials) : '',
      };
    });

    if (dataToExport.length === 0) return;

    if (format === 'json') {
      const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `places_${new Date().getTime()}.json`;
      a.click();
    } else {
      const header = Object.keys(dataToExport[0]).join(',');
      const rows = dataToExport.map(obj => Object.values(obj).map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      const csv = [header, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `places_${new Date().getTime()}.csv`;
      a.click();
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 bg-[var(--btn-secondary-bg)] border-[var(--card-border)] rounded-md px-2 py-0.5 border">
        <label className="text-[10px] text-[var(--text-muted)] font-bold uppercase">Workers:</label>
        <Input 
          type="number"
          min="1"
          max="50"
          value={chunkSize}
          onChange={(e) => setChunkSize(parseInt(e.target.value) || 1)}
          disabled={isBulkScraping}
          className="h-6 w-12 px-1 py-0 text-xs text-center bg-transparent border-none focus:ring-0 text-[var(--text-main)]"
        />
      </div>
      <Button 
        onClick={handleBulkScrape} 
        disabled={isBulkScraping || entries.length === 0 || streaming} 
        size="sm" 
        variant="outline" 
        className="h-7 text-xs bg-[var(--accent-active-bg)] border-[var(--accent-active-border)] text-[var(--accent-active-text)] hover:opacity-80"
      >
        {isBulkScraping ? 'Scraping All...' : 'Scrape Contacts For All'}
      </Button>
      <Button 
        onClick={() => handleDownload('csv')} 
        disabled={entries.length === 0} 
        size="sm" 
        variant="outline" 
        className="h-7 text-xs bg-[var(--btn-secondary-bg)] border-[var(--card-border)] text-[var(--text-main)] hover:bg-[var(--btn-secondary-hover)]"
      >
        Download CSV
      </Button>
      <Button 
        onClick={() => handleDownload('json')} 
        disabled={entries.length === 0} 
        size="sm" 
        variant="outline" 
        className="h-7 text-xs bg-[var(--btn-secondary-bg)] border-[var(--card-border)] text-[var(--text-main)] hover:bg-[var(--btn-secondary-hover)]"
      >
        Download JSON
      </Button>
    </div>
  );
}

function StarRating({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`text-xs ${
            i < full
              ? 'text-amber-400'
              : i === full && half
              ? 'text-amber-400/60'
              : 'text-white/15'
          }`}
        >
          ★
        </span>
      ))}
    </span>
  );
}

function StatusBadge({ openNow }: { openNow: boolean | null }) {
  if (openNow === null) return null;
  return (
    <Badge
      variant="outline"
      className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
        openNow
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
          : 'bg-red-500/10 border-red-500/30 text-red-400'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${openNow ? 'bg-emerald-400' : 'bg-red-400'}`} />
      {openNow ? 'Open now' : 'Closed'}
    </Badge>
  );
}

function PlaceCard({ place, isNew }: { place: PlaceResult; isNew: boolean }) {
  const [expanded, setExpanded] = useState(false);
  
  // Scraper State
  const globalScrapedData = useScrapedData();
  const [isScraping, setIsScraping] = useState(false);
  const scrapeResult = place.website ? globalScrapedData[place.website] : null;

  // Email State
  const [emailFormVisible, setEmailFormVisible] = useState(false);
  const [emailTarget, setEmailTarget] = useState('');
  const [emailSubject, setEmailSubject] = useState('Reaching out from Talha Codes');
  const [emailBodyType, setEmailBodyType] = useState<'text' | 'html'>('text');
  const [emailText, setEmailText] = useState('Hello Team,\n\nWe would love to connect and see how our services can benefit your organization.\n\nBest regards,\nTalha');
  const [emailHtml, setEmailHtml] = useState('');
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailStatus, setEmailStatus] = useState<{type: 'success'|'error', msg: string} | null>(null);

  const handleScrape = async () => {
    if (!place.website) return;
    setIsScraping(true);
    try {
      const res = await api.scrapeContacts(place.website, 5, 5, '30s');
      setGlobalScrapedData(place.website, res);
    } catch (e: any) {
      alert("Error scraping contacts: " + e.message);
    } finally {
      setIsScraping(false);
    }
  };

  const openEmailForm = (email: string) => {
    setEmailTarget(email);
    setEmailFormVisible(true);
    setEmailStatus(null);
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSendingEmail(true);
    setEmailStatus(null);
    try {
      const res = await api.sendEmail(emailTarget, emailSubject, emailText, emailHtml);
      if (res.success) {
        setEmailStatus({ type: 'success', msg: 'Email sent successfully!' });
        setTimeout(() => setEmailFormVisible(false), 2000);
      }
    } catch (e: any) {
      setEmailStatus({ type: 'error', msg: e.message || 'Failed to send email' });
    } finally {
      setIsSendingEmail(false);
    }
  };

  return (
    <Card
      className={`glass rounded-2xl border transition-all duration-500 overflow-hidden group ${
        isNew
          ? 'border-[var(--accent-active-border)] shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-400'
          : 'border-[var(--card-border)] hover:border-[var(--accent-active-border)]'
      }`}
      style={{ backgroundColor: 'var(--card-bg)' }}
    >
      {/* Header */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-[var(--text-main)] font-semibold text-base leading-tight truncate group-hover:text-[var(--accent-active-text)] transition-colors">
              {place.name}
            </CardTitle>
            {place.category && (
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{place.category}</p>
            )}
          </div>
          {place.priceLevel && (
            <Badge variant="outline" className="flex-shrink-0 text-xs font-bold bg-[var(--accent-active-bg)] border-[var(--accent-active-border)] text-[var(--accent-active-text)] px-2 py-0.5 rounded-lg">
              {place.priceLevel}
            </Badge>
          )}
        </div>

        {place.rating !== null && (
          <div className="flex items-center gap-2 mb-3">
            <span className="text-amber-400 font-bold text-sm">{place.rating.toFixed(1)}</span>
            <StarRating rating={place.rating} />
            {place.reviewCount !== null && (
              <span className="text-xs text-[var(--text-muted)]">
                ({place.reviewCount.toLocaleString()} reviews)
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <StatusBadge openNow={place.openNow} />
          {place.todaysHours && (
            <span className="text-xs text-[var(--text-muted)]">{place.todaysHours}</span>
          )}
        </div>

        <div className="space-y-1.5">
          {place.address && (
            <div className="flex items-start gap-2 text-xs text-[var(--text-subtle)]">
              <span className="mt-0.5 flex-shrink-0">📍</span>
              <span>{place.address}</span>
            </div>
          )}
          {place.phone && (
            <div className="flex items-center gap-2 text-xs text-[var(--text-subtle)]">
              <span>📞</span>
              <a href={`tel:${place.phone}`} className="hover:text-[var(--accent-active-text)] transition-colors">
                {place.phone}
              </a>
            </div>
          )}
          {place.website && (
            <div className="flex items-center gap-2 text-xs">
              <span>🌐</span>
              <a
                href={place.website}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--accent-active-text)] hover:underline truncate max-w-[240px]"
              >
                {place.website.replace(/^https?:\/\//, '')}
              </a>
              <Button 
                size="sm" 
                variant="outline" 
                className="h-6 text-[10px] px-2 ml-2 bg-[var(--accent-active-bg)] border-[var(--accent-active-border)] text-[var(--accent-active-text)] hover:opacity-80"
                onClick={handleScrape}
                disabled={isScraping}
              >
                {isScraping ? 'Scraping...' : 'Scrape Contacts'}
              </Button>
            </div>
          )}
        </div>

        {scrapeResult && (
          <div className="mt-4 p-3 bg-[var(--code-bg)] border border-[var(--card-border)] rounded-lg">
            <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold mb-2">Scraped Contacts</p>
            
            {scrapeResult.emails?.length > 0 ? (
              <div className="space-y-2 mb-2">
                {scrapeResult.emails.map((email: string, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 bg-[var(--btn-secondary-bg)] p-1.5 rounded border border-[var(--btn-secondary-border)]">
                    <a href={`mailto:${email}`} className="text-xs text-[var(--accent-active-text)] hover:underline truncate">
                      {email}
                    </a>
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      className="h-6 px-2 text-[10px] bg-[var(--accent-active-bg)] text-[var(--accent-active-text)] hover:opacity-80"
                      onClick={() => openEmailForm(email)}
                    >
                      Send Custom Email
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)] mb-2">No emails found.</p>
            )}

            {scrapeResult.phones?.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {scrapeResult.phones.map((p: string, i: number) => (
                  <Badge key={i} variant="outline" className="text-[10px] bg-[var(--btn-secondary-bg)] border-[var(--btn-secondary-border)] text-[var(--text-subtle)]">
                    📞 {p}
                  </Badge>
                ))}
              </div>
            )}
            
            {scrapeResult.socials && Object.keys(scrapeResult.socials).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {Object.entries(scrapeResult.socials).map(([platform, url]) => (
                  <a key={platform} href={url as string} target="_blank" rel="noreferrer" className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--btn-secondary-bg)] border border-[var(--btn-secondary-border)] text-[var(--text-subtle)] hover:text-[var(--text-main)] transition-colors capitalize">
                    {platform} ↗
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {emailFormVisible && (
          <div className="mt-3 p-3 bg-[var(--accent-active-bg)] border border-[var(--accent-active-border)] rounded-lg shadow-lg">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold text-[var(--text-main)]">Send Email to <span className="text-[var(--accent-active-text)]">{emailTarget}</span></p>
              <Button size="sm" variant="ghost" className="h-5 w-5 p-0 text-[var(--text-muted)] hover:text-[var(--text-main)]" onClick={() => setEmailFormVisible(false)}>✕</Button>
            </div>
            <form onSubmit={handleSendEmail} className="space-y-3">
              <div>
                <label className="block text-[10px] uppercase font-bold text-[var(--text-muted)] mb-1">Subject</label>
                <Input 
                  placeholder="Subject" 
                  value={emailSubject} 
                  onChange={e => setEmailSubject(e.target.value)}
                  required
                  className="h-8 text-xs bg-[var(--input-bg)] border-[var(--input-border)] text-[var(--input-text)]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[10px] uppercase font-bold text-[var(--text-muted)]">Body</label>
                  <div className="flex bg-[var(--input-bg)] rounded border border-[var(--input-border)] overflow-hidden">
                    <button 
                      type="button"
                      onClick={() => setEmailBodyType('text')}
                      className={`px-2 py-0.5 text-[10px] ${emailBodyType === 'text' ? 'bg-[var(--accent-active-bg)] text-[var(--accent-active-text)] font-bold' : 'text-[var(--text-muted)] hover:bg-[var(--btn-secondary-bg)]'}`}
                    >
                      Plain Text
                    </button>
                    <button 
                      type="button"
                      onClick={() => setEmailBodyType('html')}
                      className={`px-2 py-0.5 text-[10px] ${emailBodyType === 'html' ? 'bg-[var(--accent-active-bg)] text-[var(--accent-active-text)] font-bold' : 'text-[var(--text-muted)] hover:bg-[var(--btn-secondary-bg)]'}`}
                    >
                      HTML
                    </button>
                  </div>
                </div>

                {emailBodyType === 'text' ? (
                  <textarea 
                    placeholder="Plain Text Body" 
                    value={emailText} 
                    onChange={e => setEmailText(e.target.value)}
                    className="w-full h-24 p-2 text-xs bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-[var(--input-text)] focus:outline-none focus:border-[var(--accent-active-border)] resize-none"
                  />
                ) : (
                  <textarea 
                    placeholder="HTML Body" 
                    value={emailHtml} 
                    onChange={e => setEmailHtml(e.target.value)}
                    className="w-full h-24 p-2 text-xs bg-[var(--input-bg)] border border-[var(--input-border)] rounded-md text-[var(--input-text)] font-mono focus:outline-none focus:border-[var(--accent-active-border)] resize-none"
                  />
                )}
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-[10px]">
                  {emailStatus?.type === 'success' && <span className="text-emerald-500">{emailStatus.msg}</span>}
                  {emailStatus?.type === 'error' && <span className="text-red-500">{emailStatus.msg}</span>}
                </span>
                <Button type="submit" size="sm" disabled={isSendingEmail} className="h-7 text-xs bg-[var(--accent-active-bg)] text-[var(--accent-active-text)] hover:opacity-90 px-4">
                  {isSendingEmail ? 'Sending...' : 'Send'}
                </Button>
              </div>
            </form>
          </div>
        )}

        {place.description && (
          <p className="mt-3 text-xs text-[var(--text-subtle)] leading-relaxed line-clamp-2">
            {place.description}
          </p>
        )}
      </div>

      {(place.weeklyHours || (place.amenities?.length ?? 0) > 0 || place.lat !== null) && (
        <>
          <Button
            onClick={() => setExpanded((v) => !v)}
            variant="ghost"
            className="w-full px-5 py-2 h-auto flex items-center justify-between text-xs text-[var(--text-subtle)] hover:text-[var(--text-main)] border-t border-[var(--card-border)] hover:bg-[var(--btn-secondary-bg)] rounded-none transition-all font-normal"
          >
            <span>{expanded ? 'Show less' : 'More details'}</span>
            <span className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▾</span>
          </Button>

          {expanded && (
            <div className="px-5 pb-5 space-y-4 border-t border-[var(--card-border)] pt-4">
              {place.weeklyHours && Object.keys(place.weeklyHours).length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2 font-bold">Hours</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {Object.entries(place.weeklyHours).map(([day, hrs]) => (
                      <div key={day} className="flex justify-between gap-2 text-xs">
                        <span className="text-[var(--text-subtle)] font-medium">{day}</span>
                        <span className="text-[var(--text-muted)] text-right">{hrs}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(place.amenities?.length ?? 0) > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2 font-bold">Amenities</p>
                  <div className="flex flex-wrap gap-1.5">
                    {place.amenities.map((a, i) => (
                      <Badge key={i} variant="outline" className="text-[10px] bg-[var(--btn-secondary-bg)] border-[var(--card-border)] text-[var(--text-subtle)] px-2 py-0.5 rounded-full font-normal">
                        {a}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {place.lat !== null && place.lng !== null && (
                <div className="flex items-center gap-3">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">Coordinates</p>
                  <p className="text-xs text-[var(--text-subtle)] font-mono">
                    {place.lat.toFixed(6)}, {place.lng.toFixed(6)}
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {place.hasPopularTimes && (
                  <Badge variant="outline" className="text-[10px] text-purple-600 dark:text-purple-400 bg-purple-500/10 border-purple-500/20 px-2 py-0.5 rounded-full font-normal">
                    📊 Popular times
                  </Badge>
                )}
                {place.photosCount !== null && (
                  <Badge variant="outline" className="text-[10px] text-[var(--text-muted)] bg-[var(--btn-secondary-bg)] border-[var(--card-border)] px-2 py-0.5 rounded-full font-normal">
                    🖼 {place.photosCount.toLocaleString()} photos
                  </Badge>
                )}
                {place.placeId && (
                  <Badge variant="outline" className="text-[10px] text-[var(--text-muted)] bg-[var(--btn-secondary-bg)] border-[var(--card-border)] px-2 py-0.5 rounded-full font-mono font-normal">
                    ID: {place.placeId.slice(0, 24)}…
                  </Badge>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {place.mapsUrl && (
        <div className="px-5 py-3 border-t border-[var(--card-border)] flex justify-end">
          <a
            href={place.mapsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--accent-active-text)] hover:opacity-80 transition-colors font-medium"
          >
            Open in Maps ↗
          </a>
        </div>
      )}
    </Card>
  );
}

// ── Streaming progress bar ────────────────────────────────────────────────────

function StreamProgress({ round, total, done }: { round: number; total: number; done: boolean }) {
  return (
    <Card className="glass rounded-xl border border-[#0061FF]/20 p-4 flex items-center gap-4">
      <div className="relative w-8 h-8 flex-shrink-0">
        {!done ? (
          <>
            <div className="absolute inset-0 rounded-full border-2 border-[#0061FF]/20" />
            <div className="absolute inset-0 rounded-full border-2 border-[#0061FF] border-t-transparent animate-spin" />
          </>
        ) : (
          <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-sm animate-in fade-in">
            ✓
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white/70 text-sm font-medium">
          {done ? `Done — ${total} places scraped` : `Scrolling feed… ${total} places found`}
        </p>
        <p className="text-white/30 text-xs mt-0.5">
          {done ? 'All results loaded' : `Scroll round ${round} of up to 20`}
        </p>
      </div>
      <span className="text-2xl font-bold text-[#0061FF] tabular-nums">{total}</span>
    </Card>
  );
}

// ── Mode toggle ───────────────────────────────────────────────────────────────

type Mode = 'url-details' | 'google-search' | 'stream' | 'paginated';

// ── Direct URL Extractor Panel ──────────────────────────────────────────────

function UrlDetailsPanel() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<PlaceDetailResult | null>(null);

  const handleScrape = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!url.trim() || loading) return;
    setLoading(true);
    setError('');
    setDetail(null);
    try {
      const res = await api.getPlaceDetails(url.trim());
      if (res.success && res.result) {
        setDetail(res.result);
      } else {
        setError('Failed to extract place details');
      }
    } catch (err: any) {
      setError(err.message || 'Error extracting place details');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
        <div className="flex items-start justify-between mb-1">
          <div>
            <CardTitle className="text-lg font-bold text-white flex items-center gap-2">
              <span>🔗 Direct Place URL Extractor</span>
            </CardTitle>
            <CardDescription className="text-sm text-[var(--text-muted)] mt-1">
              Extract overview attributes, photos, and customer reviews instantly (sub-second performance).
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs text-[#00E5FF] bg-[#00E5FF]/10 border border-[#00E5FF]/20 px-2 py-0.5 rounded-full font-normal">
            0 clicks · Sub-second
          </Badge>
        </div>

        <form onSubmit={handleScrape} className="space-y-3 mt-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              id="place-url-input"
              type="text"
              className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[#00E5FF]/50 transition-colors text-xs font-mono"
              placeholder="https://www.google.com/maps/place/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
            />
            <Button
              type="submit"
              disabled={!url.trim() || loading}
              className="px-6 py-2.5 h-auto bg-gradient-to-r from-[#00E5FF] to-[#0061FF] rounded-xl text-white font-medium hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-[#00E5FF]/20 whitespace-nowrap"
            >
              {loading ? '⚡ Extracting…' : '🚀 Extract Details'}
            </Button>
          </div>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}
      </Card>

      {detail && (
        <Card className="glass p-6 rounded-2xl border border-white/[0.1] shadow-2xl space-y-6">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 border-b border-white/[0.08] pb-6">
            <div>
              <h2 className="text-xl font-bold text-white">{detail.name}</h2>
              {detail.category && (
                <p className="text-xs text-[#00E5FF] mt-1 font-medium">{detail.category}</p>
              )}
              {detail.rating !== null && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-amber-400 font-bold text-base">{detail.rating.toFixed(1)}</span>
                  <StarRating rating={detail.rating} />
                  {detail.reviewCount !== null && (
                    <span className="text-xs text-white/40">({detail.reviewCount.toLocaleString()} reviews)</span>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge openNow={detail.openNow} />
              {detail.priceLevel && (
                <Badge variant="outline" className="text-xs font-bold text-[#00E5FF] bg-[#00E5FF]/10 border border-[#00E5FF]/20 px-2 py-0.5 rounded-lg">
                  {detail.priceLevel}
                </Badge>
              )}
            </div>
          </div>

          {/* Attributes & Badges */}
          {detail.attributes && detail.attributes.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3">Attributes & Highlights</p>
              <div className="flex flex-wrap gap-2">
                {detail.attributes.map((attr, i) => (
                  <Badge key={i} variant="outline" className="bg-white/[0.05] border-white/10 text-white/80 px-3 py-1 rounded-xl text-xs font-normal">
                    ✨ {attr}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Overview Info Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-black/20 p-4 rounded-xl border border-white/[0.05]">
            {detail.address && (
              <div className="flex items-start gap-2 text-xs text-white/70">
                <span className="text-base">📍</span>
                <div>
                  <span className="text-white/40 block text-[10px] uppercase font-bold">Address</span>
                  <span>{detail.address}</span>
                </div>
              </div>
            )}
            {detail.phone && (
              <div className="flex items-start gap-2 text-xs text-white/70">
                <span className="text-base">📞</span>
                <div>
                  <span className="text-white/40 block text-[10px] uppercase font-bold">Phone</span>
                  <a href={`tel:${detail.phone}`} className="hover:text-[#00E5FF] transition-colors">{detail.phone}</a>
                </div>
              </div>
            )}
            {detail.website && (
              <div className="flex items-start gap-2 text-xs text-white/70">
                <span className="text-base">🌐</span>
                <div>
                  <span className="text-white/40 block text-[10px] uppercase font-bold">Website</span>
                  <a href={detail.website} target="_blank" rel="noreferrer" className="text-[#0061FF] hover:underline truncate block max-w-xs">{detail.website}</a>
                </div>
              </div>
            )}
            {detail.plusCode && (
              <div className="flex items-start gap-2 text-xs text-white/70">
                <span className="text-base">📍</span>
                <div>
                  <span className="text-white/40 block text-[10px] uppercase font-bold">Plus Code</span>
                  <span>{detail.plusCode}</span>
                </div>
              </div>
            )}
          </div>

          {/* Gallery Images */}
          {detail.images && detail.images.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3">Photos ({detail.images.length})</p>
              <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-white/10">
                {detail.images.map((img, i) => (
                  <img
                    key={i}
                    src={img}
                    alt={`Photo ${i + 1}`}
                    className="w-32 h-24 object-cover rounded-xl border border-white/10 flex-shrink-0 hover:scale-105 transition-transform"
                    onError={(e) => (e.currentTarget.style.display = 'none')}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Customer Reviews */}
          {detail.reviews && detail.reviews.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3">Customer Reviews ({detail.reviews.length})</p>
              <div className="space-y-3">
                {detail.reviews.map((rev, i) => (
                  <div key={i} className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.05] space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {rev.authorAvatar ? (
                          <img src={rev.authorAvatar} alt="" className="w-6 h-6 rounded-full" />
                        ) : (
                          <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-[10px] text-white/60">👤</div>
                        )}
                        <span className="text-xs font-semibold text-white">{rev.authorName || 'Anonymous'}</span>
                      </div>
                      {rev.rating !== null && <StarRating rating={rev.rating} />}
                    </div>
                    {rev.text && <p className="text-xs text-white/70 leading-relaxed">{rev.text}</p>}
                    {rev.relativeTime && <span className="text-[10px] text-white/30 block">{rev.relativeTime}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Paginated panel ───────────────────────────────────────────────────────────

function PaginatedPanel() {
  const [query, setQuery]         = useState('');
  const [deepScrape, setDeepScrape] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [page, setPage]           = useState(1);
  const [result, setResult]       = useState<import('../api').PlacesSearchResult | null>(null);

  const runSearch = async (pageNum: number) => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.placesSearch(query.trim(), pageNum, deepScrape);
      setResult(res);
      setPage(pageNum);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => { e?.preventDefault(); runSearch(1); };

  return (
    <div className="space-y-6">
      <Card className="glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
        <div className="flex items-start justify-between mb-1">
          <div>
            <CardTitle className="text-lg font-bold text-white">Paginated Places Search</CardTitle>
            <CardDescription className="text-xs text-[var(--text-muted)] mt-1">Fetches one page (20 results) at a time via the browser pool.</CardDescription>
          </div>
          <Badge variant="outline" className="text-xs text-white/30 bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 rounded-full font-normal">pool · page {page}</Badge>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 mt-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              id="places-pool-query"
              type="text"
              className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[#0061FF]/50 transition-colors"
              placeholder='e.g. "coffee shops in Chicago"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={loading}
            />
            <Button
              type="submit"
              disabled={!query.trim() || loading}
              className="px-6 py-2.5 h-auto bg-gradient-to-r from-[#0061FF] to-[#00E5FF] rounded-xl text-white font-medium hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-[#0061FF]/20 whitespace-nowrap"
            >
              {loading ? '⏳ Searching…' : '🔍 Search'}
            </Button>
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
            <div
              onClick={() => setDeepScrape(v => !v)}
              className={`relative w-9 h-5 rounded-full transition-colors ${deepScrape ? 'bg-[#0061FF]' : 'bg-white/10'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${deepScrape ? 'translate-x-4' : ''}`} />
            </div>
            <span className="text-xs text-white/50">Deep scrape (phone, website, hours)</span>
          </label>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
        )}
      </Card>

      {result && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-white/60 text-sm">{result.totalResultsText ?? `${result.results.length} results`}</span>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => runSearch(page - 1)}
                disabled={page <= 1 || loading}
                variant="outline"
                className="px-3 py-1.5 h-auto rounded-lg bg-white/[0.05] border border-white/[0.08] text-white/60 text-sm hover:bg-white/[0.09] disabled:opacity-30 transition-all"
              >← Prev</Button>
              <span className="text-white/40 text-xs px-2">Page {page}</span>
              <Button
                onClick={() => runSearch(page + 1)}
                disabled={!result.hasNextPage || loading}
                variant="outline"
                className="px-3 py-1.5 h-auto rounded-lg bg-white/[0.05] border border-white/[0.08] text-white/60 text-sm hover:bg-white/[0.09] disabled:opacity-30 transition-all"
              >Next →</Button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {result.results.map((place, idx) => (
              <PlaceCard key={`${place.name}-${idx}`} place={place} isNew={false} />
            ))}
          </div>

          {result.results.length === 0 && (
            <p className="text-center text-white/30 py-12 text-sm">No results found for this page.</p>
          )}
        </>
      )}
    </div>
  );
}

// ── Google Search panel ──────────────────────────────────────────────────────

type GsSubMode = 'stream' | 'paginated';



function GoogleSearchPanel() {
  const [subMode, setSubMode] = useState<GsSubMode>('stream');

  // ── Streaming state ────────────────────────────────────────────────────────
  const [sQuery, setSQuery]     = useState('');
  const [maxPages, setMaxPages] = useState(10);
  const [streaming, setStreaming] = useState(false);
  const [sDone, setSDone]       = useState(false);
  const [sError, setSError]     = useState('');
  const [sEntries, setSEntries] = useState<PlaceEntry[]>([]);
  const [sRound, setSRound]     = useState(0);
  const [sTotal, setSTotal]     = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const newNamesRef = useRef<Set<string>>(new Set());

  const stopStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  useEffect(() => () => stopStream(), [stopStream]);

  const scheduleNewFade = useCallback((names: string[]) => {
    setTimeout(() => {
      setSEntries(prev => prev.map(e => names.includes(e.place.name) ? { ...e, isNew: false } : e));
      names.forEach(n => newNamesRef.current.delete(n));
    }, 3000);
  }, []);

  const handleStreamSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!sQuery.trim() || streaming) return;
    stopStream();
    setSEntries([]);
    setSRound(0);
    setSTotal(0);
    setSDone(false);
    setSError('');
    setStreaming(true);
    newNamesRef.current.clear();

    const es = api.googleSearchPlacesStream(
      sQuery.trim(),
      (cards, newTotal, newPage) => {
        const newNames = cards.map(c => c.name);
        newNames.forEach(n => newNamesRef.current.add(n));
        setSRound(newPage);
        setSTotal(newTotal);
        setSEntries(prev => [...prev, ...cards.map(c => ({ place: c, isNew: true }))]);
        scheduleNewFade(newNames);
      },
      (finalTotal) => { setSTotal(finalTotal); setStreaming(false); setSDone(true); },
      (msg)        => { setSError(msg); setStreaming(false); setSDone(true); },
      maxPages,
    );
    esRef.current = es;
  };

  const handleStop = () => { stopStream(); setStreaming(false); setSDone(true); };

  // ── Paginated state ────────────────────────────────────────────────────────
  const [pQuery, setPQuery]   = useState('');
  const [pLoading, setPLoading] = useState(false);
  const [pError, setPError]   = useState('');
  const [pPage, setPPage]     = useState(1);
  const [pResult, setPResult] = useState<import('../api').PlacesSearchResult | null>(null);

  const runPagedSearch = async (pageNum: number) => {
    if (!pQuery.trim() || pLoading) return;
    setPLoading(true);
    setPError('');
    try {
      const res = await api.googleSearchPlaces(pQuery.trim(), pageNum);
      setPResult(res);
      setPPage(pageNum);
    } catch (e) {
      setPError((e as Error).message);
    } finally {
      setPLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Sub-mode toggle */}
      <div className="flex gap-1 p-1 bg-white/[0.04] border border-white/[0.07] rounded-xl w-fit">
        {([
          { id: 'stream', label: '📡 Auto-paginate' },
          { id: 'paginated', label: '📄 Single page' }
        ] as { id: GsSubMode; label: string }[]).map(({ id, label }) => (
          <Button
            key={id}
            onClick={() => setSubMode(id)}
            variant="outline"
            className={`px-4 py-1.5 h-auto rounded-lg text-sm font-medium transition-all ${
              subMode === id
                ? 'bg-[#00E5FF] text-black shadow shadow-[#00E5FF]/30 hover:bg-[#00E5FF]/80'
                : 'text-white/40 hover:text-white/70 border-transparent bg-transparent hover:bg-white/5'
            }`}
          >
            {label}
          </Button>
        ))}
      </div>

      {/* ── Streaming / auto-paginate mode ─────────────────────────────── */}
      {subMode === 'stream' && (
        <>
          <Card className="bg-[] glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
            <div className="flex items-start justify-between mb-1">
              <div>
                <CardTitle className="text-lg font-bold text-white">Google Search Places — Auto-paginate</CardTitle>
                <CardDescription className="text-sm text-[var(--text-muted)] mt-1">
                  Iterates Google Search pages (start=0, 20, 40…) and streams results live.
                </CardDescription>
              </div>
              <Badge variant="outline" className="text-xs text-white/30 bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 rounded-full font-normal">
                udm=1 · sse
              </Badge>
            </div>

            <form onSubmit={handleStreamSearch} className="space-y-3 mt-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <Input
                  id="gs-stream-query"
                  type="text"
                  className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[#00E5FF]/50 transition-colors"
                  placeholder='e.g. "banks in pakistan place"'
                  value={sQuery}
                  onChange={e => setSQuery(e.target.value)}
                  disabled={streaming}
                />
                {streaming ? (
                  <Button
                    type="button"
                    onClick={handleStop}
                    variant="outline"
                    className="px-6 py-2.5 h-auto bg-red-500/20 border border-red-500/30 rounded-xl text-red-400 font-medium hover:bg-red-500/30 transition-all whitespace-nowrap"
                  >
                    ⏹ Stop
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    disabled={!sQuery.trim()}
                    className="px-6 py-2.5 h-auto bg-gradient-to-r from-[#00E5FF] to-[#0061FF] rounded-xl text-white font-medium hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-[#00E5FF]/20 whitespace-nowrap"
                  >
                    🔍 Search
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs text-white/40" htmlFor="gs-max-pages">Max pages:</label>
                <select
                  id="gs-max-pages"
                  value={maxPages}
                  onChange={e => setMaxPages(Number(e.target.value))}
                  disabled={streaming}
                  className="bg-black/20 border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs focus:outline-none focus:border-[#00E5FF]/50"
                >
                  {[1,2,5,10,20,50].map(n => (
                    <option key={n} value={n}>{n} ({n * 20} results max)</option>
                  ))}
                </select>
              </div>
            </form>

            {sError && (
              <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{sError}</div>
            )}
          </Card>

          {(streaming || sDone) && (
            <StreamProgress round={sRound} total={sTotal} done={sDone && !streaming} />
          )}

          {sEntries.length > 0 && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-white/60 text-sm font-medium">
                  {sEntries.length} place{sEntries.length !== 1 ? 's' : ''}
                  {streaming && <span className="ml-2 text-[#00E5FF] animate-pulse">● live</span>}
                </span>
                {sDone && !streaming && (
                  <Badge variant="outline" className="text-xs text-emerald-400/70 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full font-normal">✓ Complete</Badge>
                )}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {sEntries.map((entry, idx) => (
                  <PlaceCard key={`${entry.place.name}-${idx}`} place={entry.place} isNew={entry.isNew} />
                ))}
              </div>
            </div>
          )}

          {streaming && sEntries.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-4 p-16">
              <div className="relative w-12 h-12">
                <div className="absolute inset-0 rounded-full border-2 border-[#00E5FF]/20" />
                <div className="absolute inset-0 rounded-full border-2 border-[#00E5FF] border-t-transparent animate-spin" />
              </div>
              <p className="text-white/40 text-sm">Navigating to Google Search…</p>
            </div>
          )}
        </>
      )}

      {/* ── Single-page paginated mode ──────────────────────────────────── */}
      {subMode === 'paginated' && (
        <div className="space-y-6">
          <Card className="glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
            <div className="flex items-start justify-between mb-1">
              <div>
                <CardTitle className="text-lg font-bold text-white">Google Search Places — Single Page</CardTitle>
                <CardDescription className="text-sm text-[var(--text-muted)] mt-1">Fetches one page (20 results) at a time via Google Search URL.</CardDescription>
              </div>
              <Badge variant="outline" className="text-xs text-white/30 bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 rounded-full font-normal">udm=1 · page {pPage}</Badge>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); runPagedSearch(1); }} className="space-y-3 mt-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <Input
                  id="gs-paged-query"
                  type="text"
                  className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[#00E5FF]/50 transition-colors"
                  placeholder='e.g. "banks in pakistan place"'
                  value={pQuery}
                  onChange={e => setPQuery(e.target.value)}
                  disabled={pLoading}
                />
                <Button
                  type="submit"
                  disabled={!pQuery.trim() || pLoading}
                  className="px-6 py-2.5 h-auto bg-gradient-to-r from-[#00E5FF] to-[#0061FF] rounded-xl text-white font-medium hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-[#00E5FF]/20 whitespace-nowrap"
                >
                  {pLoading ? '⏳ Searching…' : '🔍 Search'}
                </Button>
              </div>
            </form>

            {pError && (
              <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{pError}</div>
            )}
          </Card>

          {pResult && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-white/60 text-sm">{pResult.totalResultsText ?? `${pResult.results.length} results`}</span>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => runPagedSearch(pPage - 1)}
                    disabled={pPage <= 1 || pLoading}
                    variant="outline"
                    className="px-3 py-1.5 h-auto rounded-lg bg-white/[0.05] border border-white/[0.08] text-white/60 text-sm hover:bg-white/[0.09] disabled:opacity-30 transition-all"
                  >← Prev</Button>
                  <span className="text-white/40 text-xs px-2">Page {pPage}</span>
                  <Button
                    onClick={() => runPagedSearch(pPage + 1)}
                    disabled={!pResult.hasNextPage || pLoading}
                    variant="outline"
                    className="px-3 py-1.5 h-auto rounded-lg bg-white/[0.05] border border-white/[0.08] text-white/60 text-sm hover:bg-white/[0.09] disabled:opacity-30 transition-all"
                  >Next →</Button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {pResult.results.map((place, idx) => (
                  <PlaceCard key={`${place.name}-${idx}`} place={place} isNew={false} />
                ))}
              </div>

              {pResult.results.length === 0 && (
                <p className="text-center text-white/30 py-12 text-sm">No results found for this page.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function PlacesPanel() {
  const [mode, setMode]         = useState<Mode>('google-search');
  const [query, setQuery]       = useState('');
  const [streaming, setStreaming] = useState(false);
  const [done, setDone]         = useState(false);
  const [error, setError]       = useState('');
  const [entries, setEntries]   = useState<PlaceEntry[]>([]);
  const [round, setRound]       = useState(0);
  const [total, setTotal]       = useState(0);
  const globalScrapedData = useScrapedData();
  const [filterEmail, setFilterEmail] = useState(false);
  const [filterPhone, setFilterPhone] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const newNamesRef = useRef<Set<string>>(new Set());

  const stopStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  useEffect(() => () => stopStream(), [stopStream]);

  const scheduleNewFade = useCallback((names: string[]) => {
    setTimeout(() => {
      setEntries(prev =>
        prev.map(e => names.includes(e.place.name) ? { ...e, isNew: false } : e)
      );
      names.forEach(n => newNamesRef.current.delete(n));
    }, 3000);
  }, []);

  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim() || streaming) return;

    stopStream();
    setEntries([]);
    setRound(0);
    setTotal(0);
    setDone(false);
    setError('');
    setStreaming(true);
    newNamesRef.current.clear();

    const es = api.placesStream(
      query.trim(),
      (cards, newTotal, newRound) => {
        const newNames = cards.map(c => c.name);
        newNames.forEach(n => newNamesRef.current.add(n));
        setRound(newRound);
        setTotal(newTotal);
        setEntries(prev => [
          ...prev,
          ...cards.map(c => ({ place: c, isNew: true })),
        ]);
        scheduleNewFade(newNames);
      },
      (finalTotal) => {
        setTotal(finalTotal);
        setStreaming(false);
        setDone(true);
      },
      (msg) => {
        setError(msg);
        setStreaming(false);
        setDone(true);
      },
    );

    esRef.current = es;
  };

  const handleStop = () => {
    stopStream();
    setStreaming(false);
    setDone(true);
  };

  return (
    <div className="space-y-6 text-sm">
      {/* Mode toggle */}
      <div className="flex gap-1 p-1 bg-white/[0.04] border border-white/[0.07] rounded-xl w-fit">
        {([
          { id: 'url-details',   label: '🔗 Direct URL Scraper' },
          { id: 'google-search', label: '🔍 Google Search' },
          { id: 'stream',        label: '📡 Maps Stream' },
          { id: 'paginated',     label: '📄 Maps Paginated' },
        ] as { id: Mode; label: string }[]).map(({ id, label }) => (
          <Button
            key={id}
            onClick={() => setMode(id)}
            variant="outline"
            className={`px-4 py-1.5 h-auto rounded-lg text-sm font-medium transition-all ${
              mode === id
                ? 'bg-[#0061FF] text-white shadow shadow-[#0061FF]/30 hover:bg-[#0061FF]/80 border-transparent'
                : 'text-white/40 hover:text-white/70 border-transparent bg-transparent hover:bg-white/5'
            }`}
          >
            {label}
          </Button>
        ))}
      </div>

      {mode === 'url-details' && <UrlDetailsPanel />}
      {mode === 'google-search' && <GoogleSearchPanel />}
      {mode === 'paginated' && <PaginatedPanel />}

      {mode === 'stream' && (
      <>
      {/* Search card */}
      <Card className="glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
        <div className="flex items-start justify-between mb-1">
          <div>
            <CardTitle className="text-lg font-bold text-white">Google Maps Places Search</CardTitle>
            <CardDescription className="text-sm text-[var(--text-muted)] mt-1">
              Results appear in real-time as the browser scrolls through Google Maps.
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs text-white/30 bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 rounded-full font-normal">
            live stream
          </Badge>
        </div>

        <form onSubmit={handleSearch} className="space-y-3 mt-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              id="places-query"
              type="text"
              className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[#0061FF]/50 transition-colors"
              placeholder='e.g. "pizza near Times Square" or "dentists in London"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={streaming}
            />
            {streaming ? (
              <Button
                type="button"
                onClick={handleStop}
                variant="outline"
                className="px-6 py-2.5 h-auto bg-red-500/20 border border-red-500/30 rounded-xl text-red-400 font-medium hover:bg-red-500/30 transition-all whitespace-nowrap"
              >
                ⏹ Stop
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!query.trim()}
                className="px-6 py-2.5 h-auto bg-gradient-to-r from-[#0061FF] to-[#00E5FF] rounded-xl text-white font-medium hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-[#0061FF]/20 whitespace-nowrap"
              >
                🗺 Search Places
              </Button>
            )}
          </div>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}
      </Card>

      {(streaming || done) && entries.length >= 0 && (
        <StreamProgress round={round} total={total} done={done && !streaming} />
      )}

      {/* Results grid — grows in real-time */}
      {entries.length > 0 && (
        <div className="space-y-4">
          {(() => {
            const filteredEntries = entries.filter(e => {
              const scrape = globalScrapedData[e.place.website || ''];
              if (filterEmail) {
                if (!scrape || !scrape.emails || scrape.emails.length === 0) return false;
              }
              if (filterPhone) {
                const hasPhone = !!e.place.phone || (scrape?.phones && scrape.phones.length > 0);
                if (!hasPhone) return false;
              }
              return true;
            });
            return (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[var(--text-muted)] text-sm font-medium">
                    {filteredEntries.length} place{filteredEntries.length !== 1 ? 's' : ''}
                    {streaming && <span className="ml-2 text-[var(--accent-active-text)] animate-pulse">● live</span>}
                    {filteredEntries.length !== entries.length && ` (filtered from ${entries.length})`}
                  </span>
            <div className="flex items-center gap-3">
              <div className="flex gap-2">
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={() => setFilterEmail(v => !v)}
                  className={`h-7 text-xs ${filterEmail ? 'bg-[var(--accent-active-bg)] border-[var(--accent-active-border)] text-[var(--accent-active-text)]' : 'bg-[var(--btn-secondary-bg)] border-[var(--card-border)] text-[var(--text-main)] hover:bg-[var(--btn-secondary-hover)]'}`}
                >
                  Has Email
                </Button>
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={() => setFilterPhone(v => !v)}
                  className={`h-7 text-xs ${filterPhone ? 'bg-[var(--accent-active-bg)] border-[var(--accent-active-border)] text-[var(--accent-active-text)]' : 'bg-[var(--btn-secondary-bg)] border-[var(--card-border)] text-[var(--text-main)] hover:bg-[var(--btn-secondary-hover)]'}`}
                >
                  Has Phone
                </Button>
              </div>
              <BulkActions entries={filteredEntries} streaming={streaming} />
              {done && !streaming && (
                <Badge variant="outline" className="text-xs text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full font-normal">
                  ✓ Complete
                </Badge>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredEntries.map((entry, idx) => (
              <PlaceCard
                key={`${entry.place.name}-${idx}`}
                place={entry.place}
                isNew={entry.isNew}
              />
            ))}
          </div>
          </>
        );
      })()}
        </div>
      )}

      {/* Empty state while searching with no results yet */}
      {streaming && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-4 p-16">
          <div className="relative w-12 h-12">
            <div className="absolute inset-0 rounded-full border-2 border-[#0061FF]/20" />
            <div className="absolute inset-0 rounded-full border-2 border-[#0061FF] border-t-transparent animate-spin" />
          </div>
          <p className="text-white/40 text-sm">Navigating to Google Maps…</p>
        </div>
      )}
      </>
      )}
    </div>
  );
}
