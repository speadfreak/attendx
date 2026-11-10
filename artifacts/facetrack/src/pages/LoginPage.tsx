import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useLogin } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AuroraBackground, GradientButton, GradientCard } from "@/components/gx/Primitives";
import { BellRing, Lock, Mail, MapPin, RefreshCw, ScanFace, ShieldCheck, WifiOff, Zap } from "lucide-react";
import {
  motion,
  useAnimationControls,
  useReducedMotion,
  type Variants,
} from "framer-motion";

const FEATURES = [
  {
    icon: ScanFace,
    title: "AI face recognition",
    desc: "Camera-native check-ins in under a second, with confidence scoring.",
  },
  {
    icon: ShieldCheck,
    title: "Fraud-proof identity",
    desc: "Encrypted QR identity cards and a complete audit trail.",
  },
  {
    icon: BellRing,
    title: "Instant parent alerts",
    desc: "SMS notifications the moment a student is late or absent.",
  },
] as const;

/* Decorative trust strip — replaces the old demo-credentials footer. */
const TRUST = [
  { icon: WifiOff, label: "Offline-ready kiosk", tone: "gx-chip-teal" },
  { icon: MapPin, label: "Geofenced check-ins", tone: "gx-chip-violet" },
  { icon: RefreshCw, label: "Real-time sync", tone: "gx-chip-emerald" },
] as const;

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const reduceMotion = useReducedMotion();
  const shakeControls = useAnimationControls();
  const [signingIn, setSigningIn] = useState(false);
  const redirectTimer = useRef<number | null>(null);

  const loginMutation = useLogin({
    mutation: {
      onSuccess: (data) => {
        setSigningIn(true);
        redirectTimer.current = window.setTimeout(() => {
          login(data.token);
          setLocation("/dashboard");
        }, reduceMotion ? 0 : 420);
      },
      onError: (error) => {
        if (!reduceMotion) {
          void shakeControls.start({
            x: [0, -14, 14, -9, 9, -5, 5, 0],
            transition: { duration: 0.5, ease: "easeOut" },
          });
        }
        toast({ title: "Access Denied", description: error.message || "Invalid credentials", variant: "destructive" });
      }
    }
  });

  useEffect(() => {
    return () => {
      if (redirectTimer.current !== null) window.clearTimeout(redirectTimer.current);
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    loginMutation.mutate({ data: { email, password } });
  };

  // ── framer-motion entrance choreography (reduced-motion aware) ──
  const container: Variants = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: reduceMotion ? 0 : 0.085,
        delayChildren: reduceMotion ? 0 : 0.06,
      },
    },
  };

  const item: Variants = {
    hidden: reduceMotion ? { opacity: 1 } : { opacity: 0, y: 30, scale: 0.98 },
    show: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: { duration: reduceMotion ? 0 : 0.65, ease: EASE },
    },
  };

  // Hero moments (title, imagery, login card): spring entrance with a soft blur-in.
  const heroItem: Variants = {
    hidden: reduceMotion
      ? { opacity: 1 }
      : { opacity: 0, y: 42, scale: 0.955, filter: "blur(10px)" },
    show: {
      opacity: 1,
      y: 0,
      scale: 1,
      filter: "blur(0px)",
      transition: reduceMotion
        ? { duration: 0 }
        : { type: "spring", stiffness: 58, damping: 15, mass: 0.9 },
    },
  };

  const busy = loginMutation.isPending || signingIn;

  return (
    <main className="relative isolate min-h-screen w-full overflow-x-clip bg-[#070310] text-white">
      {/* ── Aurora wash + texture layers ─────────────────────── */}
      <AuroraBackground />
      <div
        aria-hidden="true"
        className="bg-grid-sm pointer-events-none absolute inset-0 opacity-30"
        style={{
          maskImage: "radial-gradient(75% 60% at 50% 40%, black, transparent)",
          WebkitMaskImage: "radial-gradient(75% 60% at 50% 40%, black, transparent)",
        }}
      />
      <div aria-hidden="true" className="gx-noise pointer-events-none absolute inset-0 z-20" />

      <div className="relative z-10 mx-auto grid min-h-screen w-full max-w-7xl lg:grid-cols-[1.05fr_1fr] lg:items-center">
        {/* ── LEFT: brand story ──────────────────────────────── */}
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="hidden flex-col gap-9 px-10 py-14 lg:flex xl:px-14"
        >
          <motion.p
            variants={heroItem}
            className="inline-flex items-center gap-2.5 self-start rounded-full border border-fuchsia-400/20 bg-fuchsia-400/[0.06] px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-fuchsia-200/80"
          >
            <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-300" />
            </span>
            Face-first attendance intelligence
          </motion.p>

          <motion.h1
            variants={heroItem}
            className="max-w-2xl text-5xl font-black leading-[1.05] tracking-tight xl:text-6xl"
          >
            Every arrival, <span className="text-gradient">beautifully tracked.</span>
          </motion.h1>

          <motion.p variants={item} className="max-w-md text-sm leading-relaxed text-white/45">
            AttendX pairs real-time computer vision with QR identity, SMS escalation
            and live analytics — so administrators see every classroom at a glance.
          </motion.p>

          {/* Hero image, masked into the aurora */}
          <motion.div variants={heroItem} className="w-full max-w-xl">
            <motion.div
              animate={reduceMotion ? undefined : { y: [0, -8, 0] }}
              transition={reduceMotion ? undefined : { duration: 7, repeat: Infinity, ease: "easeInOut" }}
              className="card-gradient-border gx-top-sheen relative overflow-hidden rounded-[1.75rem]"
              style={{ boxShadow: "var(--gx-glow-aurora)" }}
            >
              <img
                src="/hero.jpg"
                alt="AttendX AI face recognition"
                className="gx-hero-mask h-[42vh] w-full select-none object-cover object-top xl:h-[48vh]"
                draggable={false}
              />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#070310] via-[#070310]/10 to-transparent" />
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "linear-gradient(120deg, rgba(155,91,255,0.16), rgba(232,66,176,0.10) 45%, rgba(45,212,191,0.12))",
                }}
              />
              <div className="pointer-events-none absolute inset-x-0 top-0 h-40 overflow-hidden">
                <div className="scanning-line" />
              </div>
              <div className="absolute bottom-4 left-5 right-5 flex items-end justify-between gap-4">
                <div>
                  <p className="counter-num text-lg font-bold tracking-wide text-white">AttendX Command Center</p>
                  <p className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-white/40">
                    Real-time recognition · Addis Ababa
                  </p>
                </div>
                <span className="st-badge st-badge-purple">AI Live</span>
              </div>
            </motion.div>
          </motion.div>

          {/* Feature bullets */}
          <ul className="grid max-w-xl gap-3">
            {FEATURES.map((feature) => (
              <motion.li key={feature.title} variants={item} className="flex items-start gap-3.5">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-fuchsia-400/20 bg-gradient-to-br from-violet-500/15 via-fuchsia-500/10 to-transparent text-fuchsia-300"
                  style={{ boxShadow: "var(--gx-glow-outer)" }}
                >
                  <feature.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-white/85">{feature.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-white/40">{feature.desc}</span>
                </span>
              </motion.li>
            ))}
          </ul>
        </motion.div>

        {/* ── RIGHT: login card ──────────────────────────────── */}
        <div className="flex items-center justify-center px-6 py-12 sm:px-10 lg:py-14">
          <motion.div variants={container} initial="hidden" animate="show" className="w-full max-w-md">
            {/* compact hero mark on small screens */}
            <motion.div variants={item} className="mb-7 flex justify-center lg:hidden">
              <div className="card-gradient-border gx-top-sheen relative h-24 w-20 overflow-hidden rounded-2xl">
                <img
                  src="/hero.jpg"
                  alt=""
                  aria-hidden="true"
                  className="h-full w-full object-cover object-top"
                  draggable={false}
                />
              </div>
            </motion.div>

            <motion.div variants={heroItem} className="mb-7 text-center">
              <h2 className="counter-num text-5xl font-black tracking-[0.05em] text-white">
                ATTEND<span className="text-gradient">X</span>
              </h2>
              <p className="mt-2 text-[10px] uppercase tracking-[0.3em] text-violet-200/60">
                Intelligent Attendance Command Center
              </p>
              <div className="gx-hairline mx-auto mt-4 w-3/4" />
            </motion.div>

            <motion.div
              variants={heroItem}
              whileHover={reduceMotion ? undefined : { y: -4, scale: 1.01 }}
              transition={{ type: "spring", stiffness: 240, damping: 20 }}
            >
              {/* shake on failed login */}
              <motion.div animate={shakeControls}>
                {/* success exit flourish */}
                <motion.div
                  animate={
                    signingIn && !reduceMotion
                      ? { opacity: 0, scale: 1.04, y: -10 }
                      : { opacity: 1, scale: 1, y: 0 }
                  }
                  transition={{ duration: 0.4, ease: "easeIn" }}
                >
                  <GradientCard
                    glow
                    className="backdrop-blur-xl"
                    style={{
                      boxShadow:
                        "var(--gx-glow-aurora-strong), inset 0 1px 0 rgba(255,255,255,0.08), 0 34px 90px -18px rgba(0,0,0,0.62)",
                    }}
                  >
                    <form onSubmit={handleSubmit} className="space-y-5 p-7 sm:p-8" aria-busy={busy}>
                      <div className="group space-y-2">
                        <Label htmlFor="email" className="text-[11px] font-medium uppercase tracking-[0.16em] text-violet-200/70 transition-colors group-focus-within:text-fuchsia-200/90">
                          Identity
                        </Label>
                        <div className="relative">
                          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fuchsia-300/50 transition-colors group-focus-within:text-fuchsia-300" aria-hidden="true" />
                          <Input
                            id="email"
                            type="email"
                            autoComplete="username"
                            placeholder="you@school.edu"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="gx-focus-ring h-11 rounded-xl border-white/10 bg-white/[0.06] pl-10 text-white placeholder:text-white/25 transition-colors duration-200 hover:border-white/20 focus-visible:border-fuchsia-400/50 focus-visible:bg-white/[0.09] focus-visible:ring-0"
                          />
                        </div>
                      </div>

                      <div className="group space-y-2">
                        <Label htmlFor="password" className="text-[11px] font-medium uppercase tracking-[0.16em] text-violet-200/70 transition-colors group-focus-within:text-fuchsia-200/90">
                          Authorization Key
                        </Label>
                        <div className="relative">
                          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fuchsia-300/50 transition-colors group-focus-within:text-fuchsia-300" aria-hidden="true" />
                          <Input
                            id="password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="gx-focus-ring h-11 rounded-xl border-white/10 bg-white/[0.06] pl-10 text-white placeholder:text-white/25 transition-colors duration-200 hover:border-white/20 focus-visible:border-fuchsia-400/50 focus-visible:bg-white/[0.09] focus-visible:ring-0"
                          />
                        </div>
                      </div>

                      <GradientButton
                        type="submit"
                        className="w-full"
                        loading={busy}
                        loadingLabel="Authenticating..."
                      >
                        <Zap className="h-4 w-4" aria-hidden="true" />
                        Initialize Session
                      </GradientButton>
                    </form>

                    {/* Trust strip — compact capability chips (decorative) */}
                    <div className="border-t border-white/[0.06] px-6 py-4 sm:px-8">
                      <ul
                        className="flex flex-wrap items-center justify-center gap-2"
                        aria-label="Platform capabilities"
                      >
                        {TRUST.map((t) => (
                          <li key={t.label}>
                            <span
                              className={`gx-chip ${t.tone}`}
                              style={{ fontSize: "10px", padding: "3px 10px", gap: "6px" }}
                            >
                              <t.icon className="h-3 w-3" aria-hidden="true" />
                              {t.label}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </GradientCard>
                </motion.div>
              </motion.div>
            </motion.div>

            <motion.p variants={item} className="mt-7 text-center text-[10px] uppercase tracking-[0.22em] text-white/25">
              Developed by Joseph James · Addis Ababa, Ethiopia
            </motion.p>
          </motion.div>
        </div>
      </div>
    </main>
  );
}
