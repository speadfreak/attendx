import { Switch, Route, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { LiveEventsProvider } from "@/hooks/useLiveEvents";
import { Layout } from "@/components/Layout";
import { CommandPalette } from "@/components/CommandPalette";
import { ShieldOff } from "lucide-react";
import NotFound from "@/pages/not-found";

import LoginPage from "@/pages/LoginPage";
import DashboardPage from "@/pages/DashboardPage";
import AttendancePage from "@/pages/AttendancePage";
import StudentsPage from "@/pages/StudentsPage";
import ClassroomsPage from "@/pages/ClassroomsPage";
import ReportsPage from "@/pages/ReportsPage";
import SmsLogsPage from "@/pages/SmsLogsPage";
import AdminsPage from "@/pages/AdminsPage";
import OperationsPage from "@/pages/OperationsPage";
import ReviewQueuePage from "@/pages/ReviewQueuePage";
import FraudSignalsPage from "@/pages/FraudSignalsPage";
import GatesPage from "@/pages/GatesPage";
import QrTerminalPage from "@/pages/QrTerminalPage";
import QrManagerPage from "@/pages/QrManagerPage";
import SmsTemplatesPage from "@/pages/SmsTemplatesPage";
import AuditPage from "@/pages/AuditPage";

const queryClient = new QueryClient();

function Forbidden() {
  return (
    <div className="min-h-[50vh] flex flex-col items-center justify-center gap-4 text-center">
      <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
        <ShieldOff className="w-7 h-7 text-red-400" />
      </div>
      <div>
        <h2 className="text-xl font-bold text-white/80">Access restricted</h2>
        <p className="text-sm text-white/40 mt-1">Your role doesn't have access to this surface. Ask a super admin if you need it.</p>
      </div>
    </div>
  );
}

function ProtectedRoute({
  component: Component,
  roles,
}: {
  component: React.ComponentType;
  roles?: Array<"super_admin" | "admin" | "teacher">;
}) {
  const { isAuthenticated, isLoading, admin } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) return <Redirect to="/login" />;

  if (roles && admin && roles.length && !roles.includes(admin.role as "super_admin" | "admin" | "teacher")) {
    return (
      <Layout>
        <Forbidden />
      </Layout>
    );
  }

  return (
    <Layout>
      <Component />
    </Layout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>
      <Route path="/dashboard">{() => <ProtectedRoute component={DashboardPage} />}</Route>
      <Route path="/attendance">{() => <ProtectedRoute component={AttendancePage} />}</Route>
      <Route path="/qr-terminal">{() => <ProtectedRoute component={QrTerminalPage} />}</Route>
      <Route path="/qr-manager">{() => <ProtectedRoute component={QrManagerPage} />}</Route>
      <Route path="/students">{() => <ProtectedRoute component={StudentsPage} />}</Route>
      <Route path="/classrooms">{() => <ProtectedRoute component={ClassroomsPage} />}</Route>
      <Route path="/review-queue">{() => <ProtectedRoute component={ReviewQueuePage} />}</Route>
      <Route path="/fraud">{() => <ProtectedRoute component={FraudSignalsPage} />}</Route>
      <Route path="/reports">{() => <ProtectedRoute component={ReportsPage} />}</Route>
      <Route path="/sms-logs">{() => <ProtectedRoute component={SmsLogsPage} />}</Route>
      <Route path="/sms-templates">{() => <ProtectedRoute component={SmsTemplatesPage} roles={["super_admin", "admin"]} />}</Route>
      <Route path="/audit">{() => <ProtectedRoute component={AuditPage} roles={["super_admin", "admin"]} />}</Route>
      <Route path="/admins">{() => <ProtectedRoute component={AdminsPage} roles={["super_admin", "admin"]} />}</Route>
      <Route path="/operations">{() => <ProtectedRoute component={OperationsPage} roles={["super_admin", "admin"]} />}</Route>
      <Route path="/gates">{() => <ProtectedRoute component={GatesPage} roles={["super_admin", "admin"]} />}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <LiveEventsProvider>
            <Router />
            <CommandPalette />
          </LiveEventsProvider>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
