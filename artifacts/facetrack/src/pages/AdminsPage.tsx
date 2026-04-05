import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, ShieldCheck, ShieldAlert, Eye, EyeOff, Loader2, UserCog } from "lucide-react";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL ?? "/";

function apiFetch(path: string, options?: RequestInit) {
  const token = localStorage.getItem("ft_token");
  return fetch(`${BASE}api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });
}

type Admin = {
  id: number;
  name: string;
  email: string;
  role: string;
  createdAt: string;
};

function useAdmins() {
  return useQuery<Admin[]>({
    queryKey: ["admins"],
    queryFn: async () => {
      const res = await apiFetch("/admins");
      if (!res.ok) throw new Error("Failed to fetch admins");
      return res.json();
    },
  });
}

function useCreateAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; email: string; password: string; role: string }) => {
      const res = await apiFetch("/admins", { method: "POST", body: JSON.stringify(data) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed"); }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admins"] }),
  });
}

function useUpdateAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<{ name: string; email: string; password: string; role: string }> }) => {
      const res = await apiFetch(`/admins/${id}`, { method: "PUT", body: JSON.stringify(data) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed"); }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admins"] }),
  });
}

function useDeleteAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiFetch(`/admins/${id}`, { method: "DELETE" });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed"); }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admins"] }),
  });
}

// ---------- Admin Form Dialog ----------
function AdminFormDialog({
  admin,
  onClose,
}: {
  admin?: Admin;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const isEdit = !!admin;

  const [name, setName] = useState(admin?.name ?? "");
  const [email, setEmail] = useState(admin?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(admin?.role ?? "admin");
  const [showPass, setShowPass] = useState(false);

  const createAdmin = useCreateAdmin();
  const updateAdmin = useUpdateAdmin();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!isEdit && !password) {
      toast({ title: "Password is required for new admins", variant: "destructive" });
      return;
    }

    const payload: any = { name, email, role };
    if (password) payload.password = password;

    if (isEdit && admin) {
      updateAdmin.mutate(
        { id: admin.id, data: payload },
        {
          onSuccess: () => { toast({ title: "Admin updated" }); onClose(); },
          onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
        }
      );
    } else {
      createAdmin.mutate(
        payload,
        {
          onSuccess: () => { toast({ title: "Admin created" }); onClose(); },
          onError: (err: any) => toast({ title: "Failed to create admin", description: err.message, variant: "destructive" }),
        }
      );
    }
  };

  const isPending = createAdmin.isPending || updateAdmin.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Admin Account" : "Create New Admin"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Full Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label>Email Address</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label>{isEdit ? "New Password" : "Password"} {isEdit && <span className="text-muted-foreground text-xs">(leave blank to keep current)</span>}</Label>
            <div className="relative">
              <Input
                type={showPass ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={isEdit ? "Enter new password to change..." : "Min. 8 characters"}
                required={!isEdit}
                className="pr-10"
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPass(v => !v)}
              >
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="super_admin">Super Admin</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="pt-2 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {isEdit ? "Save Changes" : "Create Admin"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Main Page ----------
export default function AdminsPage() {
  const { admin: currentAdmin } = useAuth();
  const { toast } = useToast();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState<Admin | null>(null);

  const { data: admins, isLoading } = useAdmins();
  const deleteAdmin = useDeleteAdmin();

  const getRoleBadge = (role: string) => {
    if (role === "super_admin") {
      return (
        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-[10px] gap-1">
          <ShieldCheck className="w-3 h-3" /> Super Admin
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="bg-muted text-muted-foreground border-border text-[10px] gap-1">
        <ShieldAlert className="w-3 h-3" /> Admin
      </Badge>
    );
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      {showAddDialog && <AdminFormDialog onClose={() => setShowAddDialog(false)} />}
      {editingAdmin && <AdminFormDialog admin={editingAdmin} onClose={() => setEditingAdmin(null)} />}

      <div className="flex flex-col sm:flex-row justify-between gap-4 items-start sm:items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin Management</h1>
          <p className="text-muted-foreground">Manage system administrator accounts</p>
        </div>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setShowAddDialog(true)}>
          <Plus className="w-4 h-4 mr-2" /> Add Admin
        </Button>
      </div>

      <div className="grid gap-4">
        {isLoading ? (
          Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
        ) : !admins?.length ? (
          <Card className="bg-card border-border">
            <CardContent className="h-32 flex items-center justify-center text-muted-foreground">
              No admins found.
            </CardContent>
          </Card>
        ) : (
          admins.map((a) => (
            <motion.div key={a.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
              <Card className={`bg-card border-border transition-colors ${a.id === currentAdmin?.id ? "border-primary/30 bg-primary/5" : ""}`}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-lg font-bold border border-border">
                      {a.name.charAt(0)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-foreground">{a.name}</p>
                        {a.id === currentAdmin?.id && (
                          <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-500 border-emerald-500/20">You</Badge>
                        )}
                        {getRoleBadge(a.role)}
                      </div>
                      <p className="text-sm text-muted-foreground">{a.email}</p>
                      <p className="text-xs text-muted-foreground/60 mt-0.5">
                        Created {format(new Date(a.createdAt), "dd MMM yyyy")}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setEditingAdmin(a)}
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </Button>
                    {a.id !== currentAdmin?.id && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                        onClick={() => {
                          if (confirm(`Delete ${a.name}? This cannot be undone.`)) {
                            deleteAdmin.mutate(a.id, {
                              onSuccess: () => toast({ title: "Admin removed" }),
                              onError: (err: any) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
                            });
                          }
                        }}
                        disabled={deleteAdmin.isPending}
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))
        )}
      </div>
    </motion.div>
  );
}
