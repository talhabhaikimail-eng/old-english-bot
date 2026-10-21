import React, { useState, useRef, useCallback, useEffect } from 'react';
import { api, PlaceResult, PlaceDetailResult, PlaceReview } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { MapPin, Phone, Globe, User, BarChart3, Image as ImageIcon, X, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Check, Square, Search, Link2, Radio, FileText, Map as MapIcon, Loader2, Star } from 'lucide-react';

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
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2 py-0.5">
        <label className="text-xs font-medium text-muted-foreground">Workers</label>
        <Input 
          type="number"
          min="1"
          max="50"
          value={chunkSize}
          onChange={(e) => setChunkSize(parseInt(e.target.value) || 1)}
          disabled={isBulkScraping}
          className="h-6 w-12 px-1 py-0 text-xs text-center bg-transparent border-none focus:ring-0"
        />
      </div>
      <Button 
        onClick={handleBulkScrape} 
        disabled={isBulkScraping || entries.length === 0 || streaming} 
        size="sm" 
        variant="default" 
      >
        {isBulkScraping ? 'Scraping all...' : 'Scrape contacts for all'}
      </Button>
      <Button 
        onClick={() => handleDownload('csv')} 
        disabled={entries.length === 0} 
        size="sm" 
        variant="outline" 
        
      >
        Download CSV
      </Button>
      <Button 
        onClick={() => handleDownload('json')} 
        disabled={entries.length === 0} 
        size="sm" 
        variant="outline" 
        
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
          className={`${
            i < full
              ? 'text-amber-400'
              : i === full && half
              ? 'text-amber-400/60'
              : 'text-muted-foreground/30'
          }`}
        >
          <Star className="size-3 fill-current" />
        </span>
      ))}
    </span>
  );
}

function StatusBadge({ openNow }: { openNow: boolean | null }) {
  if (openNow === null) return null;
  return (
    <Badge
      variant={openNow ? 'default' : 'destructive'}
    >
      <span className={`size-1.5 rounded-full ${openNow ? 'bg-primary' : 'bg-destructive'}`} />
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
      className={`gap-0 py-0 transition-colors group ${
        isNew
          ? 'border-primary/50 animate-in fade-in slide-in-from-bottom-2 duration-300'
          : 'hover:border-primary/40'
      }`}
    >
      {/* Header */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm text-foreground font-semibold tracking-tight leading-tight truncate">
              {place.name}
            </CardTitle>
            {place.category && (
              <p className="text-xs text-muted-foreground mt-0.5">{place.category}</p>
            )}
          </div>
          {place.priceLevel && (
            <Badge variant="default" className="flex-shrink-0">
              {place.priceLevel}
            </Badge>
          )}
        </div>

        {place.rating !== null && (
          <div className="flex items-center gap-2 mb-3">
            <span className="text-amber-400 font-semibold text-sm">{place.rating.toFixed(1)}</span>
            <StarRating rating={place.rating} />
            {place.reviewCount !== null && (
              <span className="text-xs text-muted-foreground">
                ({place.reviewCount.toLocaleString()} reviews)
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <StatusBadge openNow={place.openNow} />
          {place.todaysHours && (
            <span className="text-xs text-muted-foreground">{place.todaysHours}</span>
          )}
        </div>

        <div className="space-y-1.5">
          {place.address && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <MapPin className="size-3.5 mt-0.5 flex-shrink-0" />
              <span>{place.address}</span>
            </div>
          )}
          {place.phone && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Phone className="size-3.5 flex-shrink-0" />
              <a href={`tel:${place.phone}`} className="hover:text-primary transition-colors">
                {place.phone}
              </a>
            </div>
          )}
          {place.website && (
            <div className="flex items-center gap-2 text-xs">
              <Globe className="size-3.5 flex-shrink-0 text-muted-foreground" />
              <a
                href={place.website}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline truncate max-w-[240px]"
              >
                {place.website.replace(/^https?:\/\//, '')}
              </a>
              <Button 
                size="sm" 
                variant="outline" 
                className="ml-2"
                onClick={handleScrape}
                disabled={isScraping}
              >
                {isScraping ? 'Scraping...' : 'Scrape contacts'}
              </Button>
            </div>
          )}
        </div>

        {scrapeResult && (
          <div className="mt-4 p-3 bg-secondary/40 border border-border rounded-lg">
            <p className="text-xs font-medium text-muted-foreground mb-2">Scraped contacts</p>
            
            {scrapeResult.emails?.length > 0 ? (
              <div className="space-y-2 mb-2">
                {scrapeResult.emails.map((email: string, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 bg-secondary p-1.5 rounded-md border border-border">
                    <a href={`mailto:${email}`} className="text-xs text-primary hover:underline truncate">
                      {email}
                    </a>
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      className="text-primary"
                      onClick={() => openEmailForm(email)}
                    >
                      Send custom email
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground mb-2">No emails found.</p>
            )}

            {scrapeResult.phones?.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {scrapeResult.phones.map((p: string, i: number) => (
                  <Badge key={i} variant="secondary">
                    <Phone />{p}
                  </Badge>
                ))}
              </div>
            )}
            
            {scrapeResult.socials && Object.keys(scrapeResult.socials).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {Object.entries(scrapeResult.socials).map(([platform, url]) => (
                  <a key={platform} href={url as string} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors capitalize">
                    {platform}<ExternalLink className="size-3" />
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {emailFormVisible && (
          <div className="mt-3 p-3 bg-secondary/40 border border-border rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-foreground">Send email to <span className="text-primary">{emailTarget}</span></p>
              <Button size="icon-sm" variant="ghost" onClick={() => setEmailFormVisible(false)}><X /></Button>
            </div>
            <form onSubmit={handleSendEmail} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Subject</label>
                <Input 
                  placeholder="Subject" 
                  value={emailSubject} 
                  onChange={e => setEmailSubject(e.target.value)}
                  required
                  className="h-8 text-xs"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-muted-foreground">Body</label>
                  <div className="flex bg-background rounded-md border border-border overflow-hidden">
                    <button 
                      type="button"
                      onClick={() => setEmailBodyType('text')}
                      className={`px-2 py-0.5 text-xs ${emailBodyType === 'text' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
                    >
                      Plain text
                    </button>
                    <button 
                      type="button"
                      onClick={() => setEmailBodyType('html')}
                      className={`px-2 py-0.5 text-xs ${emailBodyType === 'html' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
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
                    className="w-full h-24 p-2 text-xs bg-background border border-border rounded-md text-foreground focus:outline-none focus:border-primary/50 resize-none"
                  />
                ) : (
                  <textarea 
                    placeholder="HTML Body" 
                    value={emailHtml} 
                    onChange={e => setEmailHtml(e.target.value)}
                    className="w-full h-24 p-2 text-xs bg-background border border-border rounded-md text-foreground font-mono focus:outline-none focus:border-primary/50 resize-none"
                  />
                )}
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-xs">
                  {emailStatus?.type === 'success' && <span className="text-primary">{emailStatus.msg}</span>}
                  {emailStatus?.type === 'error' && <span className="text-destructive">{emailStatus.msg}</span>}
                </span>
                <Button type="submit" size="sm" disabled={isSendingEmail}>
                  {isSendingEmail ? 'Sending...' : 'Send'}
                </Button>
              </div>
            </form>
          </div>
        )}

        {place.description && (
          <p className="mt-3 text-xs text-muted-foreground leading-relaxed line-clamp-2">
            {place.description}
          </p>
        )}
      </div>

      {(place.weeklyHours || (place.amenities?.length ?? 0) > 0 || place.lat !== null) && (
        <>
          <Button
            onClick={() => setExpanded((v) => !v)}
            variant="ghost"
            className="w-full px-4 py-2 h-auto flex items-center justify-between text-xs border-t border-border rounded-none font-normal"
          >
            <span>{expanded ? 'Show less' : 'More details'}</span>
            <ChevronDown className={`size-4 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
          </Button>

          {expanded && (
            <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
              {place.weeklyHours && Object.keys(place.weeklyHours).length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Hours</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {Object.entries(place.weeklyHours).map(([day, hrs]) => (
                      <div key={day} className="flex justify-between gap-2 text-xs">
                        <span className="text-muted-foreground font-medium">{day}</span>
                        <span className="text-muted-foreground text-right">{hrs}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(place.amenities?.length ?? 0) > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Amenities</p>
                  <div className="flex flex-wrap gap-1.5">
                    {place.amenities.map((a, i) => (
                      <Badge key={i} variant="secondary">
                        {a}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {place.lat !== null && place.lng !== null && (
                <div className="flex items-center gap-3">
                  <p className="text-xs font-medium text-muted-foreground">Coordinates</p>
                  <p className="text-xs text-muted-foreground font-mono">
                    {place.lat.toFixed(6)}, {place.lng.toFixed(6)}
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {place.hasPopularTimes && (
                  <Badge variant="secondary">
                    <BarChart3 />Popular times
                  </Badge>
                )}
                {place.photosCount !== null && (
                  <Badge variant="secondary">
                    <ImageIcon />{place.photosCount.toLocaleString()} photos
                  </Badge>
                )}
                {place.placeId && (
                  <Badge variant="secondary" className="font-mono">
                    ID: {place.placeId.slice(0, 24)}…
                  </Badge>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {place.mapsUrl && (
        <div className="px-4 py-3 border-t border-border flex justify-end">
          <a
            href={place.mapsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-medium"
          >
            Open in Maps<ExternalLink className="size-3.5" />
          </a>
        </div>
      )}
    </Card>
  );
}

// ── Streaming progress bar ────────────────────────────────────────────────────

function StreamProgress({ round, total, done }: { round: number; total: number; done: boolean }) {
  return (
    <Card className="p-4 flex-row items-center gap-4">
      <div className="relative size-8 flex-shrink-0">
        {!done ? (
          <>
            <div className="absolute inset-0 rounded-full border-2 border-primary/20" />
            <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </>
        ) : (
          <div className="size-8 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center text-primary animate-in fade-in">
            <Check className="size-4" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-foreground text-sm font-medium">
          {done ? `Done — ${total} places scraped` : `Scrolling feed… ${total} places found`}
        </p>
        <p className="text-muted-foreground text-xs mt-0.5">
          {done ? 'All results loaded' : `Scroll round ${round} of up to 20`}
        </p>
      </div>
      <span className="text-xl font-semibold text-primary tabular-nums">{total}</span>
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
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-start justify-between mb-1">
          <div>
            <CardTitle className="text-sm font-semibold tracking-tight flex items-center gap-2">
              <Link2 className="size-4 text-muted-foreground" /><span>Direct place URL extractor</span>
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-0.5">
              Extract overview attributes, photos, and customer reviews instantly (sub-second performance).
            </CardDescription>
          </div>
          <Badge variant="default">
            0 clicks · Sub-second
          </Badge>
        </div>

        <form onSubmit={handleScrape} className="space-y-3 mt-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              id="place-url-input"
              type="text"
              className="flex-1 font-mono text-xs"
              placeholder="https://www.google.com/maps/place/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
            />
            <Button
              type="submit"
              disabled={!url.trim() || loading}
              className="whitespace-nowrap"
            >
              {loading ? <><Loader2 className="animate-spin" />Extracting…</> : <><Search />Extract details</>}
            </Button>
          </div>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-sm">
            {error}
          </div>
        )}
      </Card>

      {detail && (
        <Card className="p-4 space-y-5">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 border-b border-border pb-5">
            <div>
              <h2 className="text-base font-semibold tracking-tight text-foreground">{detail.name}</h2>
              {detail.category && (
                <p className="text-xs text-primary mt-1 font-medium">{detail.category}</p>
              )}
              {detail.rating !== null && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-amber-400 font-semibold text-sm">{detail.rating.toFixed(1)}</span>
                  <StarRating rating={detail.rating} />
                  {detail.reviewCount !== null && (
                    <span className="text-xs text-muted-foreground">({detail.reviewCount.toLocaleString()} reviews)</span>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge openNow={detail.openNow} />
              {detail.priceLevel && (
                <Badge variant="default">
                  {detail.priceLevel}
                </Badge>
              )}
            </div>
          </div>

          {/* Attributes & Badges */}
          {detail.attributes && detail.attributes.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-3">Attributes & highlights</p>
              <div className="flex flex-wrap gap-2">
                {detail.attributes.map((attr, i) => (
                  <Badge key={i} variant="secondary">
                    {attr}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Overview Info Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-secondary/40 p-4 rounded-lg border border-border">
            {detail.address && (
              <div className="flex items-start gap-2 text-xs text-foreground">
                <MapPin className="size-4 text-muted-foreground mt-0.5" />
                <div>
                  <span className="text-muted-foreground block text-xs font-medium">Address</span>
                  <span>{detail.address}</span>
                </div>
              </div>
            )}
            {detail.phone && (
              <div className="flex items-start gap-2 text-xs text-foreground">
                <Phone className="size-4 text-muted-foreground mt-0.5" />
                <div>
                  <span className="text-muted-foreground block text-xs font-medium">Phone</span>
                  <a href={`tel:${detail.phone}`} className="hover:text-primary transition-colors">{detail.phone}</a>
                </div>
              </div>
            )}
            {detail.website && (
              <div className="flex items-start gap-2 text-xs text-foreground">
                <Globe className="size-4 text-muted-foreground mt-0.5" />
                <div>
                  <span className="text-muted-foreground block text-xs font-medium">Website</span>
                  <a href={detail.website} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate block max-w-xs">{detail.website}</a>
                </div>
              </div>
            )}
            {detail.plusCode && (
              <div className="flex items-start gap-2 text-xs text-foreground">
                <MapPin className="size-4 text-muted-foreground mt-0.5" />
                <div>
                  <span className="text-muted-foreground block text-xs font-medium">Plus code</span>
                  <span>{detail.plusCode}</span>
                </div>
              </div>
            )}
          </div>

          {/* Gallery Images */}
          {detail.images && detail.images.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-3">Photos ({detail.images.length})</p>
              <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
                {detail.images.map((img, i) => (
                  <img
                    key={i}
                    src={img}
                    alt={`Photo ${i + 1}`}
                    className="w-32 h-24 object-cover rounded-lg border border-border flex-shrink-0"
                    onError={(e) => (e.currentTarget.style.display = 'none')}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Customer Reviews */}
          {detail.reviews && detail.reviews.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-3">Customer reviews ({detail.reviews.length})</p>
              <div className="space-y-3">
                {detail.reviews.map((rev, i) => (
                  <div key={i} className="p-4 rounded-lg bg-secondary/40 border border-border space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {rev.authorAvatar ? (
                          <img src={rev.authorAvatar} alt="" className="size-6 rounded-full" />
                        ) : (
                          <div className="size-6 rounded-full bg-secondary border border-border flex items-center justify-center text-muted-foreground"><User className="size-3.5" /></div>
                        )}
                        <span className="text-xs font-semibold text-foreground">{rev.authorName || 'Anonymous'}</span>
                      </div>
                      {rev.rating !== null && <StarRating rating={rev.rating} />}
                    </div>
                    {rev.text && <p className="text-xs text-muted-foreground leading-relaxed">{rev.text}</p>}
                    {rev.relativeTime && <span className="text-xs text-muted-foreground block">{rev.relativeTime}</span>}
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
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-start justify-between mb-1">
          <div>
            <CardTitle className="text-sm font-semibold tracking-tight">Paginated places search</CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-0.5">Fetches one page (20 results) at a time via the browser pool.</CardDescription>
          </div>
          <Badge variant="secondary">pool · page {page}</Badge>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 mt-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              id="places-pool-query"
              type="text"
              className="flex-1"
              placeholder='e.g. "coffee shops in Chicago"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={loading}
            />
            <Button
              type="submit"
              disabled={!query.trim() || loading}
              className="whitespace-nowrap"
            >
              {loading ? <><Loader2 className="animate-spin" />Searching…</> : <><Search />Search</>}
            </Button>
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
            <Switch type="button" checked={deepScrape} onCheckedChange={setDeepScrape} />
            <span className="text-xs text-muted-foreground">Deep scrape (phone, website, hours)</span>
          </label>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-sm">{error}</div>
        )}
      </Card>

      {result && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">{result.totalResultsText ?? `${result.results.length} results`}</span>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => runSearch(page - 1)}
                disabled={page <= 1 || loading}
                variant="outline"
                size="sm"
              ><ChevronLeft /> Prev</Button>
              <span className="text-muted-foreground text-xs px-2">Page {page}</span>
              <Button
                onClick={() => runSearch(page + 1)}
                disabled={!result.hasNextPage || loading}
                variant="outline"
                size="sm"
              >Next <ChevronRight /></Button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {result.results.map((place, idx) => (
              <PlaceCard key={`${place.name}-${idx}`} place={place} isNew={false} />
            ))}
          </div>

          {result.results.length === 0 && (
            <p className="text-center text-muted-foreground py-12 text-sm">No results found for this page.</p>
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
    <div className="space-y-4">
      {/* Sub-mode toggle */}
      <div className="flex flex-wrap gap-1 p-1 bg-secondary/40 border border-border rounded-lg w-fit">
        {([
          { id: 'stream', label: 'Auto-paginate', icon: Radio },
          { id: 'paginated', label: 'Single page', icon: FileText }
        ] as { id: GsSubMode; label: string; icon: typeof Radio }[]).map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            onClick={() => setSubMode(id)}
            variant={subMode === id ? 'secondary' : 'ghost'}
            size="sm"
          >
            <Icon />{label}
          </Button>
        ))}
      </div>

      {/* ── Streaming / auto-paginate mode ─────────────────────────────── */}
      {subMode === 'stream' && (
        <>
          <Card className="p-4">
            <div className="flex items-start justify-between mb-1">
              <div>
                <CardTitle className="text-sm font-semibold tracking-tight">Google Search places: auto-paginate</CardTitle>
                <CardDescription className="text-xs text-muted-foreground mt-0.5">
                  Iterates Google Search pages (start=0, 20, 40…) and streams results live.
                </CardDescription>
              </div>
              <Badge variant="secondary">
                udm=1 · sse
              </Badge>
            </div>

            <form onSubmit={handleStreamSearch} className="space-y-3 mt-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <Input
                  id="gs-stream-query"
                  type="text"
                  className="flex-1"
                  placeholder='e.g. "banks in pakistan place"'
                  value={sQuery}
                  onChange={e => setSQuery(e.target.value)}
                  disabled={streaming}
                />
                {streaming ? (
                  <Button
                    type="button"
                    onClick={handleStop}
                    variant="destructive"
                    className="whitespace-nowrap"
                  >
                    <Square /> Stop
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    disabled={!sQuery.trim()}
                    className="whitespace-nowrap"
                  >
                    <Search /> Search
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="gs-max-pages">Max pages</label>
                <select
                  id="gs-max-pages"
                  value={maxPages}
                  onChange={e => setMaxPages(Number(e.target.value))}
                  disabled={streaming}
                  className="h-7 bg-background border border-border rounded-md px-2 text-foreground text-xs focus:outline-none focus:border-primary/50"
                >
                  {[1,2,5,10,20,50].map(n => (
                    <option key={n} value={n}>{n} ({n * 20} results max)</option>
                  ))}
                </select>
              </div>
            </form>

            {sError && (
              <div className="mt-4 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-sm">{sError}</div>
            )}
          </Card>

          {(streaming || sDone) && (
            <StreamProgress round={sRound} total={sTotal} done={sDone && !streaming} />
          )}

          {sEntries.length > 0 && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-muted-foreground text-sm font-medium">
                  {sEntries.length} place{sEntries.length !== 1 ? 's' : ''}
                  {streaming && <span className="ml-2 inline-flex items-center gap-1 text-primary text-xs"><span className="size-1.5 rounded-full bg-primary animate-pulse" />Live</span>}
                </span>
                {sDone && !streaming && (
                  <Badge variant="default"><Check />Complete</Badge>
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
              <div className="relative size-10">
                <div className="absolute inset-0 rounded-full border-2 border-primary/20" />
                <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              </div>
              <p className="text-muted-foreground text-sm">Navigating to Google Search…</p>
            </div>
          )}
        </>
      )}

      {/* ── Single-page paginated mode ──────────────────────────────────── */}
      {subMode === 'paginated' && (
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex items-start justify-between mb-1">
              <div>
                <CardTitle className="text-sm font-semibold tracking-tight">Google Search places: single page</CardTitle>
                <CardDescription className="text-xs text-muted-foreground mt-0.5">Fetches one page (20 results) at a time via Google Search URL.</CardDescription>
              </div>
              <Badge variant="secondary">udm=1 · page {pPage}</Badge>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); runPagedSearch(1); }} className="space-y-3 mt-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <Input
                  id="gs-paged-query"
                  type="text"
                  className="flex-1"
                  placeholder='e.g. "banks in pakistan place"'
                  value={pQuery}
                  onChange={e => setPQuery(e.target.value)}
                  disabled={pLoading}
                />
                <Button
                  type="submit"
                  disabled={!pQuery.trim() || pLoading}
                  className="whitespace-nowrap"
                >
                  {pLoading ? <><Loader2 className="animate-spin" />Searching…</> : <><Search />Search</>}
                </Button>
              </div>
            </form>

            {pError && (
              <div className="mt-4 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-sm">{pError}</div>
            )}
          </Card>

          {pResult && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">{pResult.totalResultsText ?? `${pResult.results.length} results`}</span>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => runPagedSearch(pPage - 1)}
                    disabled={pPage <= 1 || pLoading}
                    variant="outline"
                    size="sm"
                  ><ChevronLeft /> Prev</Button>
                  <span className="text-muted-foreground text-xs px-2">Page {pPage}</span>
                  <Button
                    onClick={() => runPagedSearch(pPage + 1)}
                    disabled={!pResult.hasNextPage || pLoading}
                    variant="outline"
                    size="sm"
                  >Next <ChevronRight /></Button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {pResult.results.map((place, idx) => (
                  <PlaceCard key={`${place.name}-${idx}`} place={place} isNew={false} />
                ))}
              </div>

              {pResult.results.length === 0 && (
                <p className="text-center text-muted-foreground py-12 text-sm">No results found for this page.</p>
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
    <div className="space-y-4 text-sm">
      {/* Mode toggle */}
      <div className="flex flex-wrap gap-1 p-1 bg-secondary/40 border border-border rounded-lg w-fit">
        {([
          { id: 'url-details',   label: 'Direct URL scraper', icon: Link2 },
          { id: 'google-search', label: 'Google Search', icon: Search },
          { id: 'stream',        label: 'Maps stream', icon: Radio },
          { id: 'paginated',     label: 'Maps paginated', icon: FileText },
        ] as { id: Mode; label: string; icon: typeof Radio }[]).map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            onClick={() => setMode(id)}
            variant={mode === id ? 'secondary' : 'ghost'}
            size="sm"
          >
            <Icon />{label}
          </Button>
        ))}
      </div>

      {mode === 'url-details' && <UrlDetailsPanel />}
      {mode === 'google-search' && <GoogleSearchPanel />}
      {mode === 'paginated' && <PaginatedPanel />}

      {mode === 'stream' && (
      <>
      {/* Search card */}
      <Card className="p-4">
        <div className="flex items-start justify-between mb-1">
          <div>
            <CardTitle className="text-sm font-semibold tracking-tight">Google Maps places search</CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-0.5">
              Results appear in real-time as the browser scrolls through Google Maps.
            </CardDescription>
          </div>
          <Badge variant="secondary">
            live stream
          </Badge>
        </div>

        <form onSubmit={handleSearch} className="space-y-3 mt-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              id="places-query"
              type="text"
              className="flex-1"
              placeholder='e.g. "pizza near Times Square" or "dentists in London"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={streaming}
            />
            {streaming ? (
              <Button
                type="button"
                onClick={handleStop}
                variant="destructive"
                className="whitespace-nowrap"
              >
                <Square /> Stop
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!query.trim()}
                className="whitespace-nowrap"
              >
                <MapIcon /> Search places
              </Button>
            )}
          </div>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-sm">
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
                  <span className="text-muted-foreground text-sm font-medium">
                    {filteredEntries.length} place{filteredEntries.length !== 1 ? 's' : ''}
                    {streaming && <span className="ml-2 inline-flex items-center gap-1 text-primary text-xs"><span className="size-1.5 rounded-full bg-primary animate-pulse" />Live</span>}
                    {filteredEntries.length !== entries.length && ` (filtered from ${entries.length})`}
                  </span>
            <div className="flex items-center gap-3">
              <div className="flex gap-2">
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={() => setFilterEmail(v => !v)}
                  className={filterEmail ? 'bg-primary/10 border-primary/30 text-primary' : ''}
                >
                  Has email
                </Button>
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={() => setFilterPhone(v => !v)}
                  className={filterPhone ? 'bg-primary/10 border-primary/30 text-primary' : ''}
                >
                  Has phone
                </Button>
              </div>
              <BulkActions entries={filteredEntries} streaming={streaming} />
              {done && !streaming && (
                <Badge variant="default">
                  <Check />Complete
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
          <div className="relative size-10">
            <div className="absolute inset-0 rounded-full border-2 border-primary/20" />
            <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
          <p className="text-muted-foreground text-sm">Navigating to Google Maps…</p>
        </div>
      )}
      </>
      )}
    </div>
  );
}
