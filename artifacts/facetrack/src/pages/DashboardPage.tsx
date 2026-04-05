import { useEffect } from "react";
import { 
  useGetDashboardStats, 
  useGetRecentActivity, 
  useGetAttendanceTrend,
  useGetClassroomSummary 
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from "recharts";
import { motion } from "framer-motion";
import { Users, School, UserCheck, UserX, Clock, MessageSquare, Activity } from "lucide-react";
import { format } from "date-fns";

export default function DashboardPage() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats({
    query: { refetchInterval: 30000 }
  });
  
  const { data: trend, isLoading: trendLoading } = useGetAttendanceTrend({
    query: { refetchInterval: 30000 }
  });
  
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity({
    query: { refetchInterval: 30000 }
  });
  
  const { data: classroomStats, isLoading: classroomsLoading } = useGetClassroomSummary({
    query: { refetchInterval: 30000 }
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case "present": return "bg-emerald-500/20 text-emerald-400 border-emerald-500/20";
      case "late": return "bg-amber-500/20 text-amber-400 border-amber-500/20";
      case "absent": return "bg-red-500/20 text-red-400 border-red-500/20";
      default: return "bg-slate-500/20 text-slate-400 border-slate-500/20";
    }
  };

  const getMethodColor = (method: string) => {
    switch (method) {
      case "face": return "bg-cyan-500/20 text-cyan-400 border-cyan-500/20";
      case "qr": return "bg-blue-500/20 text-blue-400 border-blue-500/20";
      case "manual": return "bg-slate-500/20 text-slate-400 border-slate-500/20";
      default: return "bg-slate-500/20 text-slate-400 border-slate-500/20";
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }} 
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">System Overview</h1>
        <p className="text-muted-foreground flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          Live monitoring active. Auto-refreshing every 30s.
        </p>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statsLoading ? (
          Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)
        ) : (
          <>
            <Card className="bg-card/50 border-border/50 backdrop-blur-sm">
              <CardContent className="p-6">
                <div className="flex items-center justify-between space-y-0 pb-2">
                  <p className="text-sm font-medium text-muted-foreground">Global Attendance</p>
                  <Activity className="h-4 w-4 text-primary" />
                </div>
                <div className="text-3xl font-bold text-foreground">
                  {stats?.attendanceRate !== undefined ? `${(stats.attendanceRate * 100).toFixed(1)}%` : '0%'}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Today's completion rate
                </p>
              </CardContent>
            </Card>

            <Card className="bg-card/50 border-border/50 backdrop-blur-sm">
              <CardContent className="p-6">
                <div className="flex items-center justify-between space-y-0 pb-2">
                  <p className="text-sm font-medium text-muted-foreground">Present / Total</p>
                  <UserCheck className="h-4 w-4 text-emerald-500" />
                </div>
                <div className="text-3xl font-bold text-foreground">
                  {stats?.presentToday || 0} <span className="text-muted-foreground text-lg">/ {stats?.totalStudents || 0}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  <span className="text-amber-500">{stats?.lateToday || 0} late</span>, <span className="text-red-500">{stats?.absentToday || 0} absent</span>
                </p>
              </CardContent>
            </Card>

            <Card className="bg-card/50 border-border/50 backdrop-blur-sm">
              <CardContent className="p-6">
                <div className="flex items-center justify-between space-y-0 pb-2">
                  <p className="text-sm font-medium text-muted-foreground">Active Classrooms</p>
                  <School className="h-4 w-4 text-cyan-500" />
                </div>
                <div className="text-3xl font-bold text-foreground">
                  {stats?.totalClassrooms || 0}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Monitored zones
                </p>
              </CardContent>
            </Card>

            <Card className="bg-card/50 border-border/50 backdrop-blur-sm">
              <CardContent className="p-6">
                <div className="flex items-center justify-between space-y-0 pb-2">
                  <p className="text-sm font-medium text-muted-foreground">SMS Alerts Sent</p>
                  <MessageSquare className="h-4 w-4 text-blue-500" />
                </div>
                <div className="text-3xl font-bold text-foreground">
                  {stats?.smsSentToday || 0}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Automated parent notifications today
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Chart */}
        <Card className="lg:col-span-2 bg-card/50 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-lg font-medium">7-Day Attendance Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              {trendLoading ? (
                <Skeleton className="w-full h-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend || []} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorPresent" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="colorAbsent" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="colorLate" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                    <XAxis 
                      dataKey="date" 
                      stroke="#94a3b8" 
                      tickFormatter={(val) => {
                        try { return format(new Date(val), 'MMM d'); } catch { return val; }
                      }}
                    />
                    <YAxis stroke="#94a3b8" />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b' }}
                      itemStyle={{ color: '#f8fafc' }}
                      labelFormatter={(val) => {
                        try { return format(new Date(val), 'MMM d, yyyy'); } catch { return val; }
                      }}
                    />
                    <Legend />
                    <Area type="monotone" dataKey="present" name="Present" stroke="#10b981" fillOpacity={1} fill="url(#colorPresent)" />
                    <Area type="monotone" dataKey="late" name="Late" stroke="#f59e0b" fillOpacity={1} fill="url(#colorLate)" />
                    <Area type="monotone" dataKey="absent" name="Absent" stroke="#ef4444" fillOpacity={1} fill="url(#colorAbsent)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Activity Feed */}
        <Card className="bg-card/50 border-border/50 backdrop-blur-sm flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-medium flex items-center justify-between">
              Live Feed
              <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">Real-time</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto max-h-[300px] pr-2">
            {activityLoading ? (
              <div className="space-y-3">
                {Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : activity?.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                No recent activity today
              </div>
            ) : (
              <div className="space-y-4">
                {activity?.map((log) => (
                  <div key={log.id} className="flex items-start justify-between border-b border-border/50 pb-3 last:border-0 last:pb-0">
                    <div className="space-y-1">
                      <p className="text-sm font-medium leading-none">{log.studentName}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-2">
                        {format(new Date(log.markedAt), 'h:mm a')}
                        <span className="text-border">•</span>
                        {log.classroomName || 'No Class'}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="outline" className={`text-[10px] uppercase h-5 ${getStatusColor(log.status)}`}>
                        {log.status}
                      </Badge>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-medium ${getMethodColor(log.method)}`}>
                        {log.method}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Classroom Summary */}
      <Card className="bg-card/50 border-border/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-lg font-medium">Classroom Monitor</CardTitle>
        </CardHeader>
        <CardContent>
          {classroomsLoading ? (
            <Skeleton className="w-full h-48" />
          ) : !classroomStats?.length ? (
            <div className="py-8 text-center text-muted-foreground text-sm">No classroom data available</div>
          ) : (
            <div className="h-[250px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={classroomStats} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                  <XAxis dataKey="classroomName" stroke="#94a3b8" />
                  <YAxis stroke="#94a3b8" />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b' }}
                    itemStyle={{ color: '#f8fafc' }}
                    cursor={{ fill: '#1e293b', opacity: 0.4 }}
                  />
                  <Legend />
                  <Bar dataKey="presentCount" name="Present" stackId="a" fill="#10b981" radius={[0, 0, 4, 4]} />
                  <Bar dataKey="absentCount" name="Absent" stackId="a" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
