import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useLogin } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Mail, Lock, Zap } from "lucide-react";
import gsap from "gsap";

const PARTICLES = Array.from({ length: 28 }, (_, i) => i);

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const containerRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLImageElement>(null);
  const glowRing1Ref = useRef<HTMLDivElement>(null);
  const glowRing2Ref = useRef<HTMLDivElement>(null);
  const formCardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const particlesRef = useRef<HTMLDivElement[]>([]);
  const scanLineRef = useRef<HTMLDivElement>(null);
  const eyeGlowRef = useRef<HTMLDivElement>(null);
  const tickerFnRef = useRef<((...args: any[]) => void) | null>(null);

  const loginMutation = useLogin({
    mutation: {
      onSuccess: (data) => {
        gsap.to(formCardRef.current, {
          scale: 1.03, opacity: 0, duration: 0.4, ease: "power2.in",
          onComplete: () => { login(data.token); setLocation("/dashboard"); }
        });
      },
      onError: (error) => {
        gsap.to(formCardRef.current, {
          x: -12, duration: 0.07, ease: "none", repeat: 5, yoyo: true,
          onComplete: () => { gsap.set(formCardRef.current, { x: 0 }); }
        });
        toast({ title: "Access Denied", description: error.message || "Invalid credentials", variant: "destructive" });
      }
    }
  });

  useEffect(() => {
    const ctx = gsap.context(() => {
      // ── initial states ──────────────────────────────────────────
      gsap.set(logoRef.current, { opacity: 0, scale: 0.3, filter: "brightness(0)" });
      gsap.set([glowRing1Ref.current, glowRing2Ref.current], { opacity: 0, scale: 0 });
      gsap.set(formCardRef.current, { opacity: 0, y: 60 });
      gsap.set(titleRef.current, { opacity: 0, y: 20, letterSpacing: "0.5em" });
      gsap.set(subtitleRef.current, { opacity: 0, y: 10 });
      gsap.set(btnRef.current, { opacity: 0, y: 10 });
      gsap.set(scanLineRef.current, { opacity: 0 });
      gsap.set(eyeGlowRef.current, { opacity: 0, scale: 0 });

      particlesRef.current.forEach((p) => {
        if (!p) return;
        const angle = Math.random() * Math.PI * 2;
        const radius = 200 + Math.random() * 250;
        gsap.set(p, {
          opacity: 0,
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          scale: Math.random() * 0.8 + 0.3,
        });
      });

      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

      // ── logo dramatic entrance ──────────────────────────────────
      tl.to(logoRef.current, {
        opacity: 1, scale: 1, filter: "brightness(1)",
        duration: 1.2, ease: "expo.out"
      })
      // eye glow burst
      .to(eyeGlowRef.current, {
        opacity: 1, scale: 1, duration: 0.4, ease: "expo.out"
      }, "-=0.3")
      // glow rings expand
      .to(glowRing1Ref.current, {
        opacity: 1, scale: 1, duration: 0.7, ease: "expo.out"
      }, "-=0.4")
      .to(glowRing2Ref.current, {
        opacity: 1, scale: 1, duration: 0.7, ease: "expo.out", delay: 0.1
      }, "<")
      // scan line
      .to(scanLineRef.current, { opacity: 1, duration: 0.2 }, "-=0.5")
      // particles orbit in
      .to(particlesRef.current.filter(Boolean), {
        opacity: 0.7, x: 0, y: 0, duration: 1.2,
        stagger: { each: 0.03, from: "random" },
        ease: "expo.out"
      }, "-=0.8")
      // form slides up
      .to(formCardRef.current, {
        opacity: 1, y: 0, duration: 0.8, ease: "expo.out"
      }, "-=0.6")
      // title reveal
      .to(titleRef.current, {
        opacity: 1, y: 0, letterSpacing: "0.05em", duration: 0.6
      }, "-=0.5")
      .to(subtitleRef.current, { opacity: 1, y: 0, duration: 0.5 }, "-=0.3")
      .to(btnRef.current, { opacity: 1, y: 0, duration: 0.5 }, "-=0.2");

      // ── continuous animations ──────────────────────────────────
      // rings pulse
      gsap.to(glowRing1Ref.current, {
        scale: 1.08, opacity: 0.6, duration: 2, yoyo: true, repeat: -1, ease: "sine.inOut"
      });
      gsap.to(glowRing2Ref.current, {
        scale: 1.12, opacity: 0.4, duration: 2.8, yoyo: true, repeat: -1,
        ease: "sine.inOut", delay: 0.4
      });

      // logo float
      gsap.to(logoRef.current, {
        y: -8, duration: 3, yoyo: true, repeat: -1, ease: "sine.inOut"
      });

      // eye glow breathe
      gsap.to(eyeGlowRef.current, {
        opacity: 0.6, scale: 1.2, duration: 1.5, yoyo: true, repeat: -1, ease: "sine.inOut"
      });

      // particles orbit via ticker
      const speeds: number[] = [];
      const angles: number[] = [];
      const radiiX: number[] = [];
      const radiiY: number[] = [];
      particlesRef.current.forEach((p, i) => {
        if (!p) return;
        speeds[i] = 0.003 + (i % 5) * 0.0015;
        angles[i] = (i / PARTICLES.length) * Math.PI * 2;
        radiiX[i] = 100 + (i % 4) * 45;
        radiiY[i] = 80 + (i % 5) * 25;
      });

      tickerFnRef.current = () => {
        particlesRef.current.forEach((p, i) => {
          if (!p) return;
          angles[i] = (angles[i] || 0) + (speeds[i] || 0.003);
          const x = Math.cos(angles[i]) * (radiiX[i] || 100);
          const y = Math.sin(angles[i]) * (radiiY[i] || 80);
          gsap.set(p, { x, y });
        });
      };
      gsap.ticker.add(tickerFnRef.current);

      particlesRef.current.forEach((p) => {
        if (!p) return;
        gsap.to(p, {
          opacity: 0.1 + Math.random() * 0.8,
          duration: 1.5 + Math.random() * 2,
          yoyo: true, repeat: -1, ease: "sine.inOut"
        });
      });
    }, containerRef);

    return () => {
      ctx.revert();
      if (tickerFnRef.current) gsap.ticker.remove(tickerFnRef.current);
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    // button ripple on submit
    gsap.to(btnRef.current, {
      scale: 0.96, duration: 0.1, yoyo: true, repeat: 1, ease: "power2.inOut"
    });

    loginMutation.mutate({ data: { email, password } });
  };

  return (
    <div
      ref={containerRef}
      className="min-h-screen w-full flex items-center justify-center bg-[#080510] relative overflow-hidden"
    >
      {/* Grid bg */}
      <div className="absolute inset-0 bg-grid-sm opacity-60 pointer-events-none" />

      {/* Ambient glow blobs */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-purple-900/20 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-violet-800/15 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute top-0 right-1/4 w-72 h-72 bg-purple-700/10 rounded-full blur-[80px] pointer-events-none" />

      {/* ── LEFT: Logo + particles ─────────────────────────── */}
      <div className="hidden lg:flex flex-1 items-center justify-center relative">
        {/* Particle field */}
        <div className="absolute inset-0 flex items-center justify-center">
          {PARTICLES.map((i) => (
            <div
              key={i}
              ref={(el) => { if (el) particlesRef.current[i] = el; }}
              className="particle absolute"
              style={{ width: i % 4 === 0 ? 6 : 3, height: i % 4 === 0 ? 6 : 3 }}
            />
          ))}
        </div>

        {/* Glow rings */}
        <div
          ref={glowRing1Ref}
          className="absolute w-[360px] h-[360px] rounded-full border border-purple-500/25 pointer-events-none"
          style={{ boxShadow: "0 0 40px rgba(155,91,255,0.15), inset 0 0 40px rgba(155,91,255,0.05)" }}
        />
        <div
          ref={glowRing2Ref}
          className="absolute w-[480px] h-[480px] rounded-full border border-purple-500/15 pointer-events-none"
        />

        {/* Scan line overlay */}
        <div className="absolute w-[300px] h-[380px] rounded-2xl overflow-hidden pointer-events-none">
          <div ref={scanLineRef} className="scanning-line" />
        </div>

        {/* Eye glow */}
        <div
          ref={eyeGlowRef}
          className="absolute w-28 h-12 rounded-full"
          style={{
            background: "radial-gradient(ellipse, rgba(155,91,255,0.8) 0%, transparent 70%)",
            top: "calc(50% - 60px)",
            filter: "blur(6px)"
          }}
        />

        {/* AI Face Recognition Hero */}
        <img
          ref={logoRef}
          src="/hero.jpg"
          alt="AttendX AI"
          className="relative z-10 w-80 h-auto object-cover rounded-3xl select-none panther-logo"
          style={{ maxHeight: "75vh", objectPosition: "center top" }}
          draggable={false}
        />
      </div>

      {/* ── RIGHT: Login Form ──────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center px-6 lg:px-12 relative z-10">
        <div ref={formCardRef} className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="lg:hidden flex justify-center mb-6">
            <img
              src="/hero.jpg"
              alt="AttendX"
              className="w-24 h-32 object-cover rounded-2xl panther-logo"
              style={{ objectPosition: "center top" }}
            />
          </div>

          {/* Title */}
          <div className="mb-8">
            <h1
              ref={titleRef}
              className="text-4xl font-black tracking-tight text-white mb-2"
              style={{ fontFamily: "'Orbitron', monospace" }}
            >
              ATTEND<span className="text-purple-400 text-glow-sm">X</span>
            </h1>
            <p ref={subtitleRef} className="text-purple-300/70 text-sm tracking-widest uppercase">
              Intelligent Attendance Command Center
            </p>
            <div className="mt-3 h-px bg-gradient-to-r from-purple-500/50 via-violet-400/30 to-transparent" />
          </div>

          {/* Card */}
          <div className="glass-panel rounded-2xl p-8">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-purple-200/80 text-xs tracking-widest uppercase">
                  Identity
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-purple-400/60 h-4 w-4" />
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    placeholder="you@school.edu"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="pl-10 bg-white/5 border-purple-500/20 text-white focus-visible:ring-purple-500/50 focus-visible:border-purple-500/50 placeholder:text-white/20 transition-all"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-purple-200/80 text-xs tracking-widest uppercase">
                  Authorization Key
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-purple-400/60 h-4 w-4" />
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-10 bg-white/5 border-purple-500/20 text-white focus-visible:ring-purple-500/50 focus-visible:border-purple-500/50 placeholder:text-white/20 transition-all"
                  />
                </div>
              </div>

              <button
                ref={btnRef}
                type="submit"
                disabled={loginMutation.isPending}
                className="w-full relative overflow-hidden py-3 px-6 rounded-xl font-semibold text-white text-sm tracking-widest uppercase transition-all duration-300 disabled:opacity-60"
                style={{
                  background: "linear-gradient(135deg, #7C3AED, #9B5BFF, #6D28D9)",
                  boxShadow: "0 0 20px rgba(124,58,237,0.4), 0 4px 24px rgba(124,58,237,0.2)",
                }}
                onMouseEnter={(e) => {
                  gsap.to(e.currentTarget, { scale: 1.02, duration: 0.2 });
                }}
                onMouseLeave={(e) => {
                  gsap.to(e.currentTarget, { scale: 1, duration: 0.2 });
                }}
              >
                {loginMutation.isPending ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Authenticating...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <Zap className="h-4 w-4" />
                    Initialize Session
                  </span>
                )}
                {/* Shimmer */}
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full hover:translate-x-full transition-transform duration-700" />
              </button>
            </form>

            <div className="mt-6 pt-5 border-t border-purple-500/10 text-center">
              <p className="text-[10px] text-purple-300/40 uppercase tracking-widest">Demo Access</p>
              <p className="text-xs font-mono text-purple-300/60 mt-1">
                admin@gmail.com <span className="text-purple-500/40 mx-1">·</span> admin_password
              </p>
            </div>
          </div>

          {/* Footer */}
          <p className="text-center text-[10px] text-purple-300/25 mt-6 tracking-widest uppercase">
            Developed by Joseph James · Addis Ababa, Ethiopia
          </p>
        </div>
      </div>
    </div>
  );
}
