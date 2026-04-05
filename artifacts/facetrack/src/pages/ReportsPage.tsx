import { useState } from "react";
import { 
  useListAttendance, 
  useListClassrooms 
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import { Download, Filter, FileSpreadsheet } from "lucide-react";
import { format } from "date-fns";

export default function ReportsPage() {
  const [date, setDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [classroomId, setClassroomId] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");

  const { data: classrooms } = useListClassrooms();
  
  const { data: records, isLoading } = useListAttendance({
    date: date || undefined,
    classroomId: classroomId === "all" ? undefined : Number(classroomId),
    status: status === "all" ? undefined : status
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "present": return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/20 uppercase text-[10px]">Present</Badge>;
      case "late": return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/20 uppercase text-[10px]">Late</Badge>;
      case "absent": return <Badge className="bg-red-500/20 text-red-400 border-red-500/20 uppercase text-[10px]">Absent</Badge>;
      default: return <Badge variant="outline" className="uppercase text-[10px]">{status}</Badge>;
    }
  };

  const exportCSV = () => {
    if (!records || records.length === 0) return;
    
    const headers = ["Student Name", "Classroom", "Status", "Method", "Date/Time", "Notes"];
    const csvContent = [
      headers.join(","),
      ...records.map(r => [
        `"${r.studentName}"`,
        `"${r.classroomName || ''}"`,
        r.status,
        r.method,
        format(new Date(r.markedAt), 'yyyy-MM-dd HH:mm:ss'),
        `"${r.notes || ''}"`
      ].join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `attendance_export_${date}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const presentCount = records?.filter(r => r.status === 'present').length || 0;
  const lateCount = records?.filter(r => r.status === 'late').length || 0;
  const absentCount = records?.filter(r => r.status === 'absent').length || 0;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between gap-4 items-start sm:items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Attendance Reports</h1>
          <p className="text-muted-foreground">Historical data and exports</p>
        </div>
        
        <Button onClick={exportCSV} disabled={!records?.length} variant="outline" className="border-primary/50 text-primary hover:bg-primary/10">
          <Download className="w-4 h-4 mr-2" /> Export CSV
        </Button>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3 border-b border-border/50">
          <div className="flex flex-col sm:flex-row gap-4 items-end sm:items-center">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Filter className="w-4 h-4" />
              <span className="text-sm font-medium">Filters:</span>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full sm:w-auto flex-1">
              <Input 
                type="date" 
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full"
              />
              
              <Select value={classroomId} onValueChange={setClassroomId}>
                <SelectTrigger>
                  <SelectValue placeholder="All Classrooms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Classrooms</SelectItem>
                  {classrooms?.map(c => (
                    <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="present">Present</SelectItem>
                  <SelectItem value="late">Late</SelectItem>
                  <SelectItem value="absent">Absent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        
        {/* Stats Bar */}
        <div className="flex bg-muted/20 border-b border-border/50">
          <div className="flex-1 p-4 text-center border-r border-border/50">
            <p className="text-2xl font-bold text-emerald-500">{presentCount}</p>
            <p className="text-xs text-muted-foreground uppercase font-medium mt-1">Present</p>
          </div>
          <div className="flex-1 p-4 text-center border-r border-border/50">
            <p className="text-2xl font-bold text-amber-500">{lateCount}</p>
            <p className="text-xs text-muted-foreground uppercase font-medium mt-1">Late</p>
          </div>
          <div className="flex-1 p-4 text-center border-r border-border/50">
            <p className="text-2xl font-bold text-red-500">{absentCount}</p>
            <p className="text-xs text-muted-foreground uppercase font-medium mt-1">Absent</p>
          </div>
          <div className="flex-1 p-4 text-center">
            <p className="text-2xl font-bold text-foreground">{records?.length || 0}</p>
            <p className="text-xs text-muted-foreground uppercase font-medium mt-1">Total Logs</p>
          </div>
        </div>

        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Classroom</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array(5).fill(0).map((_, i) => (
                  <TableRow key={i}>
                    {Array(6).fill(0).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : records?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    No attendance records found for these filters.
                  </TableCell>
                </TableRow>
              ) : (
                records?.map((record) => (
                  <TableRow key={record.id} className="hover:bg-muted/30">
                    <TableCell className="font-medium">{record.studentName}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{record.classroomName || 'Unassigned'}</TableCell>
                    <TableCell>{getStatusBadge(record.status)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] uppercase">{record.method}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {format(new Date(record.markedAt), 'h:mm a')}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs italic">
                      {record.notes || '-'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </motion.div>
  );
}
