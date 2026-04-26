import React, { useState } from 'react';
import { Heart, Copy, ExternalLink, ArrowLeft, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../ui';

const METHODS = [
  {
    id: 'github',
    label: 'GitHub Sponsors',
    description: 'Recurring or one-time — directly through GitHub.',
    url: 'https://github.com/sponsors/omnivoice-studio',
    icon: '🐙',
    type: 'link',
  },
  {
    id: 'patreon',
    label: 'Patreon',
    description: 'Monthly support with early access perks.',
    url: 'https://patreon.com/omnivoicestudio',
    icon: '🎨',
    type: 'link',
  },
  {
    id: 'kofi',
    label: 'Ko-fi',
    description: 'Buy the team a coffee. No account needed.',
    url: 'https://ko-fi.com/omnivoicestudio',
    icon: '☕',
    type: 'link',
  },
  {
    id: 'btc',
    label: 'Bitcoin',
    description: 'Native BTC — any amount.',
    address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    icon: '₿',
    type: 'crypto',
    network: 'Bitcoin (BTC)',
    protocol: 'bitcoin',
  },
  {
    id: 'eth',
    label: 'Ethereum',
    description: 'ETH or ERC-20 tokens.',
    address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    icon: 'Ξ',
    type: 'crypto',
    network: 'Ethereum (ETH / ERC-20)',
    protocol: 'ethereum',
  },
  {
    id: 'sol',
    label: 'Solana',
    description: 'SOL or SPL tokens.',
    address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',
    icon: '◎',
    type: 'crypto',
    network: 'Solana (SOL)',
    protocol: 'solana',
  },
];

function CryptoCard({ method, delay }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(method.address);
      setCopied(true);
      toast.success(`${method.label} address copied`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Copy failed');
    }
  };
  return (
    <div 
      className="group relative flex items-start gap-5 rounded-3xl border border-white/10 bg-black/30 px-5 py-5 shadow-lg backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:bg-black/40 hover:shadow-[0_8px_30px_rgba(211,134,155,0.15)] sm:px-7"
      style={{ animation: `fade-in-up 0.6s ease-out ${delay}ms both` }}
    >
      <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-white/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 pointer-events-none" />
      
      <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/5 text-xl shadow-inner border border-white/5 transition-transform duration-300 group-hover:scale-110">
        {method.icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 z-10">
        <div className="text-lg font-medium tracking-tight text-white/90 group-hover:text-white transition-colors">{method.label}</div>
        <div className="text-sm leading-relaxed text-white/60">{method.description}</div>
        <div className="mt-2 flex flex-wrap items-center gap-2 sm:gap-3">
          <code className="min-w-0 max-w-[180px] flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-xl bg-black/40 px-3 py-2 text-[11px] text-white/50 border border-white/5 font-mono sm:text-xs sm:max-w-[280px]">
            {method.address}
          </code>
          <div className="flex shrink-0 gap-1.5">
            <button
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/5 text-white/50 transition-all duration-200 hover:bg-white/15 hover:text-white hover:scale-105 active:scale-95"
              onClick={handleCopy}
              title="Copy address"
            >
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            </button>
            {method.protocol && (
              <button
                className="flex h-8 px-3 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-white/5 text-[11px] font-medium tracking-wide text-white/70 transition-all duration-200 hover:bg-[#d3869b]/20 hover:text-[#d3869b] hover:border-[#d3869b]/30 hover:scale-105 active:scale-95 border border-white/5"
                onClick={() => window.open(`${method.protocol}:${method.address}`, '_self')}
                title="Open in desktop wallet"
              >
                <ExternalLink size={12} />
                <span className="hidden sm:inline">Open</span>
              </button>
            )}
          </div>
        </div>
        <span className="mt-1 text-[0.65rem] font-semibold tracking-wider uppercase text-white/30">{method.network}</span>
      </div>

      <div className="hidden sm:block z-10 shrink-0 self-center rounded-xl bg-white p-2 border border-white/20 transition-transform duration-300 group-hover:scale-105 shadow-md">
        <QRCodeSVG 
          value={`${method.protocol || ''}:${method.address}`} 
          size={64} 
          bgColor="#ffffff" 
          fgColor="#000000" 
          level="M" 
          includeMargin={false} 
        />
      </div>
    </div>
  );
}

function LinkCard({ method, delay }) {
  return (
    <div 
      className="group relative flex items-center gap-5 rounded-3xl border border-white/10 bg-black/30 px-5 py-5 shadow-lg backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:bg-black/40 hover:shadow-[0_8px_30px_rgba(211,134,155,0.15)] sm:px-7"
      style={{ animation: `fade-in-up 0.6s ease-out ${delay}ms both` }}
    >
      <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-white/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 pointer-events-none" />
      
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/5 text-xl shadow-inner border border-white/5 transition-transform duration-300 group-hover:scale-110">
        {method.icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 z-10">
        <div className="text-lg font-medium tracking-tight text-white/90 group-hover:text-white transition-colors">{method.label}</div>
        <div className="text-sm leading-relaxed text-white/60">{method.description}</div>
      </div>
      <button
        className="z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white/50 transition-all duration-200 hover:border-[#d3869b]/40 hover:bg-[#d3869b]/10 hover:text-[#d3869b] hover:scale-105 active:scale-95"
        onClick={() => window.open(method.url, '_blank', 'noopener,noreferrer')}
        title={`Open ${method.label}`}
      >
        <ExternalLink size={16} />
      </button>
    </div>
  );
}

export default function DonatePage({ onBack }) {
  const links = METHODS.filter(m => m.type === 'link');
  const crypto = METHODS.filter(m => m.type === 'crypto');

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-[#050505]">
      {/* Abstract Background Layer (Pure CSS + SVG) */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        {/* Glowing Orbs */}
        <div className="absolute -top-[200px] -left-[200px] w-[800px] h-[800px] rounded-full bg-[radial-gradient(circle,rgba(168,85,247,0.12)_0%,rgba(168,85,247,0)_70%)] animate-[drift_20s_infinite_linear]" />
        <div className="absolute -bottom-[100px] -right-[100px] w-[600px] h-[600px] rounded-full bg-[radial-gradient(circle,rgba(236,72,153,0.08)_0%,rgba(236,72,153,0)_70%)] animate-[drift_15s_infinite_linear_reverse]" />
        <div className="absolute top-[40%] left-[50%] w-[900px] h-[900px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(99,102,241,0.08)_0%,rgba(99,102,241,0)_70%)] animate-[drift_25s_infinite_ease-in-out_alternate]" />
        
        {/* Subtle SVG Voice Waveforms */}
        <div className="absolute inset-0 opacity-40 mix-blend-screen overflow-hidden">
          <svg className="absolute w-[200%] h-[60%] top-[20%] left-0 animate-[wave-move_15s_linear_infinite]" preserveAspectRatio="none" viewBox="0 0 2000 1000" xmlns="http://www.w3.org/2000/svg">
            <path fill="none" stroke="url(#wave-grad-1)" strokeWidth="3" d="M0,500 C250,300 750,700 1000,500 C1250,300 1750,700 2000,500" />
            <path fill="none" stroke="url(#wave-grad-2)" strokeWidth="2" d="M0,500 C300,650 700,350 1000,500 C1300,650 1700,350 2000,500" />
            <path fill="none" stroke="url(#wave-grad-3)" strokeWidth="1.5" d="M0,500 C400,400 600,600 1000,500 C1400,400 1600,600 2000,500" />
            <defs>
              <linearGradient id="wave-grad-1" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#d3869b" stopOpacity="0" />
                <stop offset="25%" stopColor="#d3869b" stopOpacity="0.8" />
                <stop offset="50%" stopColor="#d3869b" stopOpacity="0" />
                <stop offset="75%" stopColor="#d3869b" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#d3869b" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="wave-grad-2" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#818cf8" stopOpacity="0" />
                <stop offset="25%" stopColor="#818cf8" stopOpacity="0.6" />
                <stop offset="50%" stopColor="#818cf8" stopOpacity="0" />
                <stop offset="75%" stopColor="#818cf8" stopOpacity="0.6" />
                <stop offset="100%" stopColor="#818cf8" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="wave-grad-3" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#f472b6" stopOpacity="0" />
                <stop offset="25%" stopColor="#f472b6" stopOpacity="0.5" />
                <stop offset="50%" stopColor="#f472b6" stopOpacity="0" />
                <stop offset="75%" stopColor="#f472b6" stopOpacity="0.5" />
                <stop offset="100%" stopColor="#f472b6" stopOpacity="0" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        {/* Noise Texture */}
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E')" }} />
      </div>
      
      {/* Content Layer */}
      <div className="relative z-10 flex flex-col px-6 pb-12 sm:px-10 h-full">
        <div className="shrink-0 py-6">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={onBack} 
            leading={<ArrowLeft size={16} />}
            className="text-white/70 hover:text-white hover:bg-white/10 backdrop-blur-md rounded-xl"
          >
            Back to Studio
          </Button>
        </div>

        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-12">
          {/* Hero Section */}
          <div className="pt-8 text-center animate-fade-in">
            <div className="relative mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-white/10 to-transparent border border-white/10 shadow-[0_0_40px_rgba(211,134,155,0.2)] backdrop-blur-xl">
              <Heart size={36} className="text-[#f3a5b6] drop-shadow-[0_0_15px_rgba(243,165,182,0.8)] animate-[pulse_3s_ease-in-out_infinite] [fill:#f3a5b6]" />
            </div>
            
            <h2 className="mx-0 my-4 font-serif text-4xl font-semibold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-pink-200 via-purple-200 to-indigo-200 sm:text-5xl">
              Support OmniVoice
            </h2>
            
            <p className="mx-auto mt-6 max-w-[500px] text-lg font-light leading-relaxed text-white/60">
              OmniVoice is free, open-source, and runs entirely on your hardware. 
              If it brings value to your workflow, consider supporting the core team.
            </p>
          </div>

          <div className="flex flex-col gap-10">
            {/* Platforms */}
            <section>
              <div className="mb-6 flex items-center gap-4">
                <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/10" />
                <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">Platforms</h3>
                <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/10" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {links.map((m, i) => <LinkCard key={m.id} method={m} delay={100 + i * 100} />)}
              </div>
            </section>

            {/* Cryptocurrency */}
            <section>
              <div className="mb-6 flex items-center gap-4">
                <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/10" />
                <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">Cryptocurrency</h3>
                <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/10" />
              </div>
              <div className="flex flex-col gap-4">
                {crypto.map((m, i) => <CryptoCard key={m.id} method={m} delay={400 + i * 100} />)}
              </div>
            </section>
          </div>

          <div className="mt-8 mb-12 text-center">
            <p className="text-sm font-medium tracking-wide text-white/40">
              Every contribution helps push the boundaries of local AI. ♥
            </p>
          </div>
        </div>
      </div>

      <style jsx="true">{`
        @keyframes fade-in-up {
          0% { opacity: 0; transform: translateY(15px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes wave-move {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes drift {
          0% { transform: rotate(0deg) translate(0, 0); }
          33% { transform: rotate(120deg) translate(20px, 40px); }
          66% { transform: rotate(240deg) translate(-20px, -40px); }
          100% { transform: rotate(360deg) translate(0, 0); }
        }
        .animate-fade-in {
          animation: fade-in-up 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
      `}</style>
    </div>
  );
}
