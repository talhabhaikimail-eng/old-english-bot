import React, { useState, useRef, useEffect } from 'react';
import { api, BrowserSearchResult } from '../api';
import {
  Search, Mic, Camera, Globe, MapPin, Video, Newspaper, ShoppingBag,
  Clock, CloudSun, BookOpen, Languages, ChevronDown, ChevronUp,
  ExternalLink, Image, Play, Star, Info, Moon, Sun, ArrowLeft, RefreshCw, X,
  Loader2
} from 'lucide-react';

type SearchTab = 'all' | 'images' | 'videos';

interface GoogleClonePanelProps {
  isStandalone?: boolean;
}

export default function GoogleClonePanel({ isStandalone = false }: GoogleClonePanelProps) {
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BrowserSearchResult | null>(null);
  const [isSearched, setIsSearched] = useState(false);
  const [activeTab, setActiveTab] = useState<SearchTab>('all');
  const [darkMode, setDarkMode] = useState(true);
  const [openPaaIndex, setOpenPaaIndex] = useState<number | null>(null);
  const [selectedImage, setSelectedImage] = useState<{ alt: string; sourceUrl: string; imageUrl?: string } | null>(null);

  // Sync initial query if there's a URL hash or query param (for direct link feature)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if (q) {
      setQuery(q);
      executeSearch(q, 1);
    }
  }, []);

  // Reactive effect: refetch results whenever the active category tab changes
  useEffect(() => {
    if (isSearched && (query || activeQuery)) {
      executeSearch(query || activeQuery, 1, activeTab);
    }
  }, [activeTab]);

  const executeSearch = async (searchQuery: string, targetPage: number, tabCategory: SearchTab = activeTab) => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setError('');
    setIsSearched(true);
    setActiveQuery(searchQuery);

    try {
      const res = await api.browserSearch(searchQuery, targetPage, 'auto', true, tabCategory);
      setResult(res);
      setPage(targetPage);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch search results from CDP Browser Pool');
    } finally {
      setLoading(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeSearch(query, 1, activeTab);
  };

  const handleClear = () => {
    setQuery('');
  };

  const handleReset = () => {
    setIsSearched(false);
    setResult(null);
    setQuery('');
    setActiveQuery('');
    setPage(1);
    setError('');
    setActiveTab('all');
  };

  const togglePaa = (index: number) => {
    setOpenPaaIndex(openPaaIndex === index ? null : index);
  };

  return (
    <div className={`${isStandalone ? 'h-screen w-full overflow-y-auto' : 'min-h-[85vh] rounded-3xl border'} transition-all duration-300 ${darkMode
      ? `bg-[#0f0f13] text-white ${isStandalone ? '' : 'border-white/[0.08]'}`
      : `bg-[#f8f9fa] text-gray-900 ${isStandalone ? '' : 'border-gray-200'}`
      }`}>
      {/* Top Header Actions */}
      <div className={`flex justify-between items-center px-6 py-4 border-b ${darkMode ? 'border-white/[0.05]' : 'border-gray-200'
        }`}>
        <div className="flex items-center gap-2">
          {isSearched && (
            <button
              onClick={handleReset}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all border ${darkMode
                ? 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08] text-white/70'
                : 'bg-gray-100 border-gray-300 hover:bg-gray-200 text-gray-700'
                }`}
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back Home
            </button>
          )}
          <span className={`text-[10px] tracking-wider uppercase font-mono px-2 py-0.5 rounded ${darkMode ? 'bg-[#0061FF]/10 text-[#0061FF]' : 'bg-blue-100 text-blue-700'
            }`}>
            Google Clone
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setDarkMode(!darkMode)}
            className={`p-2 rounded-full border transition-all ${darkMode
              ? 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08] text-yellow-400'
              : 'bg-white border-gray-300 hover:bg-gray-100 text-slate-700 shadow-sm'
              }`}
            title={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Main Home Screen */}
      {!isSearched ? (
        <div className="flex flex-col items-center justify-center py-20 px-4 md:py-32">
          {/* Multicolor Logo */}
          <div className="text-6xl md:text-8xl font-bold select-none mb-8 tracking-tight font-sans flex items-center justify-center">
            <span className="text-blue-500">G</span>
            <span className="text-red-500">o</span>
            <span className="text-yellow-500">o</span>
            <span className="text-blue-500">g</span>
            <span className="text-green-500">l</span>
            <span className="text-red-500">e</span>
            <span className="text-xs ml-1 px-1.5 py-0.5 rounded font-mono font-bold bg-[#0061FF]/20 text-[#0061FF] self-end mb-2 shadow">
              Clone
            </span>
          </div>

          {/* Search Box */}
          <form onSubmit={handleSearchSubmit} className="w-full max-w-2xl px-2">
            <div className={`flex items-center rounded-full border px-4 py-3.5 md:px-5 md:py-4 transition-all duration-300 ${darkMode
              ? 'bg-[#1E2330] border-white/10 focus-within:bg-[#202029] focus-within:border-white/20 focus-within:shadow-lg focus-within:shadow-black/40'
              : 'bg-white border-gray-200 focus-within:bg-white focus-within:border-blue-400 focus-within:shadow-lg focus-within:shadow-gray-200'
              }`}>
              <Search className={`w-5 h-5 mr-3 flex-shrink-0 ${darkMode ? 'text-white/30' : 'text-gray-400'}`} />
              <input
                type="text"
                className={`flex-1 bg-transparent border-none outline-none font-sans text-base focus:ring-0 p-0 ${darkMode ? 'text-white' : 'text-gray-900'}`}
                placeholder="Search Google Clone or type URL..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  type="button"
                  onClick={handleClear}
                  className={`p-1 rounded-full mr-2 ${darkMode ? 'hover:bg-white/10 text-white/40' : 'hover:bg-gray-100 text-gray-400'}`}
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <div className={`hidden sm:flex items-center gap-2 border-l pl-3 ml-1 ${darkMode ? 'border-white/10' : 'border-gray-200'}`}>
                <span title="Search by Voice">
                  <Mic className="w-5 h-5 text-blue-500 cursor-pointer hover:opacity-85" />
                </span>
                <span title="Search by Image (Lens)">
                  <Camera className="w-5 h-5 text-green-500 cursor-pointer hover:opacity-85" />
                </span>
              </div>
            </div>

            {/* Buttons */}
            <div className="flex flex-row flex-wrap justify-center gap-3 mt-8">
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className={`px-5 py-2.5 rounded-lg text-sm font-semibold transition-all shadow ${darkMode
                  ? 'bg-[#1E2330] hover:bg-[#23232c] hover:text-white text-white/80 border border-white/5'
                  : 'bg-gray-100 hover:bg-gray-200 hover:text-gray-900 text-gray-800 border border-gray-300/40'
                  }`}
              >
                Google Search
              </button>
              <button
                type="button"
                onClick={() => {
                  const items = ['Pakistan historical spots', 'Weather in Tokyo', 'Who is the Prime Minister of Pakistan', 'Local food near Islamabad', 'Gemini AI vs GPT-4'];
                  const random = items[Math.floor(Math.random() * items.length)];
                  setQuery(random);
                  executeSearch(random, 1, activeTab);
                }}
                className={`px-5 py-2.5 rounded-lg text-sm font-semibold transition-all shadow ${darkMode
                  ? 'bg-[#1E2330] hover:bg-[#23232c] hover:text-white text-white/80 border border-white/5'
                  : 'bg-gray-100 hover:bg-gray-200 hover:text-gray-900 text-gray-800 border border-gray-300/40'
                  }`}
              >
                I'm Feeling Lucky
              </button>
            </div>
          </form>

          {/* Languages offered */}
          <div className={`text-xs mt-10 ${darkMode ? 'text-white/40' : 'text-gray-500'}`}>
            Google offered in: <span className="text-[#0061FF] hover:underline cursor-pointer">English</span> · <span className="text-[#0061FF] hover:underline cursor-pointer">Urdu</span> · <span className="text-[#0061FF] hover:underline cursor-pointer">Pushto</span> · <span className="text-[#0061FF] hover:underline cursor-pointer">Punjabi</span>
          </div>
        </div>
      ) : (
        /* Results Mode Screen */
        <div className="flex flex-col">
          {/* Top Search Bar & Tabs Wrapper */}
          <div className={`px-4 md:px-8 pt-4 pb-0 border-b shadow-sm sticky top-0 z-20 ${darkMode ? 'bg-[#0f0f13]/95 border-white/[0.05] backdrop-blur-md' : 'bg-white/95 border-gray-200 backdrop-blur-md'
            }`}>
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4 mb-4">
              {/* Logo */}
              <div
                onClick={handleReset}
                className="text-2xl font-bold select-none cursor-pointer tracking-tight flex items-center flex-shrink-0"
              >
                <span className="text-blue-500">G</span>
                <span className="text-red-500">o</span>
                <span className="text-yellow-500">o</span>
                <span className="text-blue-500">g</span>
                <span className="text-green-500">l</span>
                <span className="text-red-500">e</span>
              </div>

              {/* Input Box */}
              <form onSubmit={handleSearchSubmit} className="flex-1 max-w-2xl">
                <div className={`flex items-center rounded-full border px-4 py-2 transition-all ${darkMode
                  ? 'bg-[#1E2330] border-white/10 focus-within:bg-[#202029] focus-within:border-white/20'
                  : 'bg-white border-gray-200 focus-within:border-blue-400 focus-within:shadow-sm'
                  }`}>
                  <input
                    type="text"
                    className={`flex-1 bg-transparent border-none outline-none font-sans text-sm focus:ring-0 p-0 ${darkMode ? 'text-white' : 'text-gray-900'}`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={handleClear}
                      className={`p-1 rounded-full mr-2 ${darkMode ? 'hover:bg-white/10 text-white/40' : 'hover:bg-gray-100 text-gray-400'}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <div className={`flex items-center gap-2 border-l pl-3 ml-1 ${darkMode ? 'border-white/10' : 'border-gray-200'}`}>
                    <Search
                      className="w-4 h-4 text-blue-500 cursor-pointer hover:opacity-85"
                      onClick={() => executeSearch(query, 1, activeTab)}
                    />
                  </div>
                </div>
              </form>
            </div>

            {/* Navigation Tabs */}
            <div className="flex gap-4 overflow-x-auto scrollbar-none font-sans text-sm">
              {(['all', 'images', 'videos'] as SearchTab[]).map(tab => (
                <button
                  key={tab}
                  onClick={() => {
                    setActiveTab(tab);
                  }}
                  className={`flex items-center gap-1.5 pb-3 pt-1 border-b-2 font-medium capitalize transition-all ${activeTab === tab
                    ? (darkMode ? 'border-[#0061FF] text-white' : 'border-blue-600 text-blue-600')
                    : `border-transparent ${darkMode ? 'text-white/40 hover:text-white/60' : 'text-gray-500 hover:text-gray-800'}`
                    }`}
                >
                  {tab === 'all' && <Globe className="w-4 h-4" />}
                  {tab === 'images' && <Image className="w-4 h-4" />}
                  {tab === 'videos' && <Video className="w-4 h-4" />}
                  <span>{tab}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Loading Indicator */}
          {loading && (
            <div className="flex flex-col items-center justify-center p-24 gap-3">
              <div className="w-10 h-10 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            </div>
          )}

          {/* Error State */}
          {!loading && error && (
            <div className="p-8 max-w-3xl mx-auto">
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-5 rounded-2xl flex flex-col gap-2">
                <span className="font-bold text-sm">Search Failed</span>
                <span className="text-xs leading-relaxed">{error}</span>
                <button
                  onClick={() => executeSearch(activeQuery, page)}
                  className="mt-3 px-4 py-2 bg-red-500 text-white rounded-lg text-xs font-semibold self-start hover:bg-red-600 transition-colors"
                >
                  Retry Search
                </button>
              </div>
            </div>
          )}

          {/* Results Display */}
          {!loading && result && (
            <div className="px-4 md:px-8 py-6  mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-8">

              {/* LEFT COLUMN: Results, Weather, AI, News (Span 8) */}
              <div className="lg:col-span-8 space-y-6">


                {/* 2. Direct Answer widget */}
                {activeTab === 'all' && result.directAnswer && (
                  <div className={`p-6 rounded-2xl border shadow-md transition-all ${darkMode
                    ? 'bg-[#1E2330] border-white/[0.06]'
                    : 'bg-white border-gray-200'
                    }`}>
                    <div className={`flex items-center gap-2 text-xs mb-3 uppercase tracking-wider font-mono ${darkMode ? 'text-white/40' : 'text-gray-500'}`}>
                      {result.directAnswer.type === 'weather' ? <CloudSun className="w-4 h-4 text-yellow-400" /> : <Clock className="w-4 h-4 text-blue-600" />}
                      <span>Direct Answer: {result.directAnswer.type}</span>
                    </div>

                    {result.directAnswer.type === 'weather' ? (
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                        <div>
                          <div className={`text-4xl font-bold font-sans tracking-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>{result.directAnswer.answer}</div>
                          <div className={`text-sm font-semibold mt-1 ${darkMode ? 'text-white' : 'text-gray-800'}`}>{result.directAnswer.details?.split(' - ')[1] || 'Current Weather'}</div>
                        </div>
                        <div className={`text-right sm:text-left text-xs leading-relaxed border-t sm:border-t-0 sm:border-l pt-3 sm:pt-0 sm:pl-4 ${darkMode ? 'text-white/50 border-white/10' : 'text-gray-500 border-gray-200'}`}>
                          {result.directAnswer.details || ''}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className={`text-4xl font-bold font-mono tracking-tight ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>{result.directAnswer.answer}</div>
                        {result.directAnswer.details && (
                          <div className={`text-sm mt-1 ${darkMode ? 'text-white/60' : 'text-gray-600'}`}>{result.directAnswer.details}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 3. Featured Snippet card */}
                {activeTab === 'all' && result.featuredSnippet && (
                  <div className={`p-6 rounded-2xl border shadow-sm transition-all ${darkMode
                    ? 'bg-[#1E2330] border-white/[0.06]'
                    : 'bg-white border-gray-200'
                    }`}>
                    <div className={`flex items-center gap-1.5 text-xs mb-3 uppercase tracking-wider font-mono ${darkMode ? 'text-white/40' : 'text-gray-500'}`}>
                      <BookOpen className="w-4 h-4 text-indigo-500" />
                      <span>Featured Snippet</span>
                    </div>
                    <p className={`text-base md:text-lg leading-relaxed mb-4 font-serif ${darkMode ? 'text-white/90' : 'text-slate-800'
                      }`}>
                      "{result.featuredSnippet.snippet}"
                    </p>
                    <a
                      href={result.featuredSnippet.link}
                      target="_blank"
                      rel="noreferrer"
                      className={`group block border-t pt-3 ${darkMode ? 'border-white/5' : 'border-gray-200'}`}
                    >
                      <div className={`text-xs font-semibold group-hover:underline truncate ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>{result.featuredSnippet.title}</div>
                      <div className={`text-[10px] truncate mt-0.5 ${darkMode ? 'text-white/30' : 'text-gray-400'}`}>{result.featuredSnippet.link}</div>
                    </a>
                  </div>
                )}

                {/* Tab Filtering & Organic Results rendering */}

                {/* 4A. TAB = ALL: Render organic results + PAA + carousels */}
                {activeTab === 'all' && (
                  <div className="space-y-6">
                    {/* AI Overview (SGE) */}
                    {result.aiResponse && (
                      <div className={`p-6 rounded-2xl border shadow-md transition-all ${darkMode
                        ? 'bg-[#1E2330]/40 border-[#00E5FF]/30 text-white'
                        : 'bg-emerald-50/10 border-emerald-200 text-gray-800'
                        }`}>
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-[#00E5FF] text-lg">✨</span>
                          <h4 className={`font-bold text-sm tracking-wider uppercase font-sans ${darkMode ? 'text-[#00E5FF]' : 'text-emerald-700'}`}>AI Overview</h4>
                        </div>
                        <div
                          className={`text-sm leading-relaxed whitespace-pre-wrap ${darkMode ? 'text-white/80' : 'text-slate-800'}`}
                          dangerouslySetInnerHTML={{ __html: result.aiResponse }}
                        />
                      </div>
                    )}

                    {/* Organic List */}
                    <div className="space-y-4">
                      {result.organic.length === 0 ? (
                        <div className={`text-center py-12 text-sm ${darkMode ? 'text-white/30' : 'text-gray-400'}`}>No organic web links found for this query.</div>
                      ) : (
                        result.organic.map((item, idx) => (
                          <div key={idx} className="group">
                            {/* Header / Breadcrumbs */}
                            <div className={`flex items-center gap-2 mb-1 text-xs truncate ${darkMode ? 'text-white/40' : 'text-gray-500'}`}>
                              {item.favicon && (
                                <img
                                  src={item.favicon}
                                  alt="Favicon"
                                  className="w-4 h-4 rounded-full flex-shrink-0"
                                  onError={(e) => (e.currentTarget.style.display = 'none')}
                                />
                              )}
                              <span className={`truncate font-sans ${darkMode ? 'text-white/60' : 'text-gray-600'}`}>{item.displayedLink || item.link}</span>
                            </div>

                            {/* Link Title */}
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noreferrer"
                              className={`text-lg md:text-xl font-sans group-hover:underline block leading-tight mb-1 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}
                            >
                              {item.title}
                            </a>

                            {/* Snippet */}
                            <p className={`text-sm leading-relaxed ${darkMode ? 'text-white/65' : 'text-slate-700'}`}>
                              {item.snippet}
                            </p>
                          </div>
                        ))
                      )}
                    </div>

                    {/* People Also Ask (PAA) section */}
                    {result.peopleAlsoAsk && result.peopleAlsoAsk.length > 0 && (
                      <div className={`border rounded-2xl overflow-hidden transition-all ${darkMode ? 'border-white/10 bg-white/[0.01]' : 'border-gray-200 bg-gray-50/50'
                        }`}>
                        <div className={`px-5 py-4 border-b font-bold text-sm ${darkMode ? 'border-white/10' : 'border-gray-200'}`}>
                          People also ask
                        </div>
                        <div className={`divide-y ${darkMode ? 'divide-white/5' : 'divide-gray-200'}`}>
                          {result.peopleAlsoAsk.map((paa, idx) => (
                            <div key={idx} className="transition-all">
                              <button
                                onClick={() => togglePaa(idx)}
                                className={`w-full flex justify-between items-center px-5 py-3.5 text-left text-sm font-semibold ${darkMode ? 'hover:bg-white/[0.02]' : 'hover:bg-gray-100'}`}
                              >
                                <span>{paa.question}</span>
                                <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${openPaaIndex === idx ? 'rotate-180 text-blue-400' : ''}`} />
                              </button>
                              {openPaaIndex === idx && (
                                <div className={`px-5 pb-5 pt-1 text-xs leading-relaxed ${darkMode ? 'text-white/60' : 'text-slate-600'}`}>
                                  {paa.answer ? (
                                    <div className="space-y-3">
                                      <p className="font-serif">"{paa.answer}"</p>
                                      {paa.sourceUrl && (
                                        <a
                                          href={paa.sourceUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="inline-flex items-center gap-1 text-blue-500 font-semibold hover:underline"
                                        >
                                          <span>{paa.sourceTitle || 'Learn more'}</span>
                                          <ExternalLink className="w-3.5 h-3.5" />
                                        </a>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="italic">No inline answer extracted, check links below.</span>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 4B. TAB = IMAGES: Render gorgeous image card gallery */}
                {activeTab === 'images' && (
                  <div className="space-y-6">
                    <h4 className={`font-bold text-sm uppercase tracking-wider mb-3 ${darkMode ? 'text-white/40' : 'text-gray-500'}`}>Google Images Results</h4>
                    {!result.images || result.images.length === 0 ? (
                      <div className={`text-center py-16 text-sm ${darkMode ? 'text-white/30' : 'text-gray-400'}`}>No images crawled for this query.</div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {result.images.map((img, idx) => (
                          <div
                            key={idx}
                            onClick={() => setSelectedImage(img)}
                            className={`group rounded-2xl overflow-hidden border cursor-pointer transition-all hover:scale-[1.02] shadow-sm hover:shadow-md ${darkMode ? 'bg-[#1E2330] border-white/[0.06]' : 'bg-white border-gray-200'
                              }`}
                          >
                            <div className="relative aspect-video bg-black/40 overflow-hidden flex items-center justify-center">
                              {img.imageUrl ? (
                                <img
                                  src={img.imageUrl}
                                  alt={img.alt || 'Crawled result'}
                                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                  onError={(e) => (e.currentTarget.src = 'https://placehold.co/600x400/png?text=Preview+Unavailable')}
                                />
                              ) : (
                                <span className={`text-xs ${darkMode ? 'text-white/20' : 'text-gray-400'}`}>No image data</span>
                              )}
                            </div>
                            <div className="p-3">
                              <p className={`text-xs font-semibold truncate leading-tight transition-colors ${darkMode ? 'text-white group-hover:text-blue-400' : 'text-gray-900 group-hover:text-blue-700'}`}>
                                {img.alt || 'Untitled Image'}
                              </p>
                              <p className={`text-[10px] truncate mt-1 ${darkMode ? 'text-white/30' : 'text-gray-500'}`}>{img.sourceUrl}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 4C. TAB = VIDEOS: Render structured video list */}
                {activeTab === 'videos' && (
                  <div className="space-y-4">
                    <h4 className={`font-bold text-sm uppercase tracking-wider mb-3 ${darkMode ? 'text-white/40' : 'text-gray-500'}`}>Google Video Results</h4>
                    {!result.videos || result.videos.length === 0 ? (
                      <div className={`text-center py-16 text-sm ${darkMode ? 'text-white/30' : 'text-gray-400'}`}>No videos found for this query.</div>
                    ) : (
                      result.videos.map((vid, idx) => (
                        <div
                          key={idx}
                          className={`p-4 rounded-2xl border flex flex-col sm:flex-row gap-4 transition-all shadow-sm ${darkMode ? 'bg-[#1E2330] border-white/[0.06]' : 'bg-white border-gray-200'
                            }`}
                        >
                          {/* Left: Thumbnail Simulation */}
                          <a
                            href={vid.link}
                            target="_blank"
                            rel="noreferrer"
                            className="w-full sm:w-48 aspect-video bg-black/40 rounded-xl flex items-center justify-center relative overflow-hidden group flex-shrink-0"
                          >
                            <div className="absolute inset-0 bg-[#0061FF]/10 group-hover:bg-[#0061FF]/20 transition-colors" />
                            <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-lg transform group-hover:scale-110 transition-transform">
                              <Play className="w-5 h-5 fill-current ml-0.5" />
                            </div>
                            {vid.duration && (
                              <span className="absolute bottom-2 right-2 text-[10px] font-mono font-bold bg-black/75 px-1.5 py-0.5 rounded text-white">
                                {vid.duration}
                              </span>
                            )}
                          </a>

                          {/* Right: Info */}
                          <div className="flex-1 flex flex-col justify-between">
                            <div>
                              <div className={`flex items-center gap-2 text-[10px] mb-1 ${darkMode ? 'text-white/40' : 'text-gray-500'}`}>
                                <span className="font-semibold uppercase tracking-wider text-blue-500">{vid.source}</span>
                                {vid.uploadedAt && <span>· {vid.uploadedAt}</span>}
                              </div>
                              <a
                                href={vid.link}
                                target="_blank"
                                rel="noreferrer"
                                className={`text-base font-bold transition-colors group-hover:underline block leading-tight mb-2 ${darkMode ? 'text-white hover:text-blue-400' : 'text-gray-900 hover:text-blue-700'}`}
                              >
                                {vid.title}
                              </a>
                            </div>

                            <a
                              href={vid.link}
                              target="_blank"
                              rel="noreferrer"
                              className={`text-xs truncate block hover:underline ${darkMode ? 'text-white/30' : 'text-gray-500'}`}
                            >
                              {vid.link}
                            </a>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}



                {/* 5. Related Queries (Clickable to perform new search) */}
                {result.relatedSearches && result.relatedSearches.length > 0 && (
                  <div className={`pt-6 border-t space-y-3 ${darkMode ? 'border-white/[0.06]' : 'border-gray-200'}`}>
                    <h5 className={`font-bold text-xs uppercase tracking-wider ${darkMode ? 'text-white/30' : 'text-gray-500'}`}>Related Searches</h5>
                    <div className="flex flex-wrap gap-2">
                      {result.relatedSearches.map((term, idx) => (
                        <button
                          key={idx}
                          onClick={() => {
                            setQuery(term);
                            executeSearch(term, 1, activeTab);
                          }}
                          className={`px-4 py-2 rounded-full text-xs font-semibold border transition-all ${darkMode
                            ? 'bg-white/[0.03] border-white/10 text-white/60 hover:bg-white/[0.08] hover:text-white'
                            : 'bg-gray-100 border-gray-300 text-slate-700 hover:bg-gray-200 hover:text-black shadow-sm'
                            }`}
                        >
                          🔍 {term}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Page Pagination buttons */}
                <div className="flex justify-center gap-3 pt-8">
                  <button
                    disabled={page <= 1}
                    onClick={() => executeSearch(activeQuery, page - 1, activeTab)}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border ${darkMode
                      ? 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08] disabled:opacity-30'
                      : 'bg-white border-gray-300 hover:bg-gray-100 disabled:opacity-30 shadow-sm text-slate-800'
                      }`}
                  >
                    Prev Page
                  </button>
                  <div className={`px-4 py-2 flex items-center justify-center text-xs font-mono font-bold ${darkMode ? 'text-white/40' : 'text-gray-500'}`}>
                    Page {page}
                  </div>
                  <button
                    onClick={() => executeSearch(activeQuery, page + 1, activeTab)}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border ${darkMode
                      ? 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08]'
                      : 'bg-white border-gray-300 hover:bg-gray-100 shadow-sm text-slate-800'
                      }`}
                  >
                    Next Page
                  </button>
                </div>

              </div>

              {/* RIGHT COLUMN: Sidebar (Span 4) */}
              <div className="lg:col-span-4 space-y-6">

                {/* A. Knowledge Panel Card */}
                {result.knowledgePanel ? (
                  <div className={`rounded-2xl border shadow-md overflow-hidden transition-all ${darkMode ? 'bg-[#1E2330] border-white/[0.06]' : 'bg-white border-gray-200'
                    }`}>
                    {/* Header Banner simulation */}
                    <div className={`p-5 border-b ${darkMode ? 'bg-gradient-to-r from-blue-500/10 to-indigo-500/10 border-white/5' : 'bg-gray-50 border-gray-200'}`}>
                      <div className="text-[10px] uppercase font-bold text-indigo-500 mb-1 tracking-wider">Knowledge Graph Info</div>
                      <h3 className={`text-xl font-extrabold tracking-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>{result.knowledgePanel.title}</h3>
                      {result.knowledgePanel.subtitle && (
                        <p className={`text-xs mt-0.5 leading-snug ${darkMode ? 'text-white/50' : 'text-gray-500'}`}>{result.knowledgePanel.subtitle}</p>
                      )}
                    </div>

                    <div className="p-5 space-y-4">
                      {result.knowledgePanel.description && (
                        <div className="space-y-3">
                          <p className={`text-xs leading-relaxed ${darkMode ? 'text-white/70' : 'text-slate-600'}`}>
                            {result.knowledgePanel.description}
                          </p>
                          {result.knowledgePanel.sourceUrl && (
                            <a
                              href={result.knowledgePanel.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-blue-500 font-bold hover:underline"
                            >
                              <span>Read full topic source</span>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      )}

                      {/* Fact attributes list */}
                      {result.knowledgePanel.attributes && result.knowledgePanel.attributes.length > 0 && (
                        <div className={`border-t pt-4 space-y-3 ${darkMode ? 'border-white/5' : 'border-gray-200'}`}>
                          {result.knowledgePanel.attributes.map((attr, idx) => (
                            <div key={idx} className="flex flex-col gap-0.5 text-xs">
                              <span className={`font-bold uppercase tracking-wide text-[9px] ${darkMode ? 'text-white/40' : 'text-gray-500'}`}>{attr.label}</span>
                              <span className={`font-semibold leading-relaxed ${darkMode ? 'text-white/80' : 'text-gray-800'}`}>{attr.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className={`p-5 rounded-2xl border text-center text-xs transition-all ${darkMode ? 'bg-[#1E2330]/50 border-white/[0.04] text-white/30' : 'bg-gray-50 border-gray-200 text-gray-400'
                    }`}>
                    No direct sidebar knowledge graph exists for this exact search. Try querying a topic like a country, celebrity, or weather location.
                  </div>
                )}





              </div>

            </div>
          )}
        </div>
      )}

      {/* Lightbox Modal for Image Preview */}
      {selectedImage && (
        <div
          className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-in fade-in duration-300"
          onClick={() => setSelectedImage(null)}
        >
          <button
            onClick={() => setSelectedImage(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all"
          >
            <X className="w-6 h-6" />
          </button>

          <div
            className="bg-[#1E2330] border border-white/10 max-w-4xl w-full rounded-3xl overflow-hidden shadow-2xl animate-in zoom-in-95 duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative bg-black flex items-center justify-center p-4 max-h-[70vh]">
              <img
                src={selectedImage.imageUrl}
                alt={selectedImage.alt}
                className="max-w-full max-h-[60vh] object-contain rounded-lg"
              />
            </div>
            <div className="p-6 border-t border-white/5">
              <h3 className="text-lg font-bold text-white leading-tight mb-2">{selectedImage.alt || 'Crawled Google Image Result'}</h3>
              <p className="text-xs text-white/40 truncate mb-4">Source URL: {selectedImage.sourceUrl}</p>

              <a
                href={selectedImage.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 rounded-xl text-xs font-bold text-white shadow transition-colors"
              >
                <span>Visit Source Site</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </div>
      )}


    </div>
  );
}
