import { useState } from "react";
import { 
  useListClassrooms, 
  useCreateClassroom,
  useDeleteClassroom
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { Plus, School, Users, User, Trash2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";

export default function ClassroomsPage() {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const { toast } = useToast();

  const { data: classrooms, isLoading, refetch } = useListClassrooms();

  const createClassroom = useCreateClassroom({
    mutation: {
      onSuccess: () => {
        refetch();
        setIsAddOpen(false);
        toast({ title: "Classroom created successfully" });
      },
      onError: (err: any) => {
        toast({ title: "Failed to create classroom", description: err.message, variant: "destructive" });
      }
    }
  });

  const deleteClassroom = useDeleteClassroom({
    mutation: {
      onSuccess: () => {
        refetch();
        toast({ title: "Classroom deleted" });
      },
      onError: (err: any) => {
        toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      }
    }
  });

  const handleAddSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createClassroom.mutate({
      data: {
        name: formData.get("name") as string,
        teacherName: formData.get("teacherName") as string,
        description: formData.get("description") as string,
      }
    });
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between gap-4 items-start sm:items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Classrooms</h1>
          <p className="text-muted-foreground">Manage monitored zones and homerooms</p>
        </div>
        
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-2" /> New Classroom
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create New Classroom</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleAddSubmit} className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="name">Classroom Name/ID</Label>
                <Input id="name" name="name" placeholder="e.g. Room 101, Science Lab" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="teacherName">Assigned Teacher</Label>
                <Input id="teacherName" name="teacherName" placeholder="e.g. Mr. Smith" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Notes (Optional)</Label>
                <Textarea id="description" name="description" />
              </div>
              <div className="pt-4 flex justify-end">
                <Button type="submit" disabled={createClassroom.isPending}>
                  {createClassroom.isPending ? "Creating..." : "Create Classroom"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {isLoading ? (
          Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-48 rounded-xl" />)
        ) : classrooms?.length === 0 ? (
          <div className="col-span-full py-12 text-center border-2 border-dashed border-border rounded-xl">
            <School className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
            <h3 className="text-lg font-medium">No classrooms found</h3>
            <p className="text-muted-foreground text-sm mt-1">Create a classroom to start organizing students.</p>
          </div>
        ) : (
          classrooms?.map((classroom) => (
            <Card key={classroom.id} className="bg-card border-border hover:border-primary/50 transition-colors group">
              <CardHeader className="pb-3 border-b border-border/50">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                      <School size={20} />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{classroom.name}</CardTitle>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Added {format(new Date(classroom.createdAt), 'MMM d, yyyy')}
                      </p>
                    </div>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-8 w-8 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-opacity"
                    onClick={() => {
                      if(confirm(`Delete ${classroom.name}? This will unassign all students in it.`)) {
                        deleteClassroom.mutate({ id: classroom.id });
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-4 pb-2">
                <div className="space-y-3">
                  <div className="flex items-center gap-3 text-sm">
                    <User className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground w-16">Teacher:</span>
                    <span className="font-medium text-foreground">{classroom.teacherName || 'None assigned'}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Users className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground w-16">Students:</span>
                    <span className="font-medium text-foreground">{classroom.studentCount} enrolled</span>
                  </div>
                </div>
              </CardContent>
              {classroom.description && (
                <CardFooter className="pt-2 pb-4 text-xs text-muted-foreground italic border-t border-border/50 mt-2">
                  {classroom.description}
                </CardFooter>
              )}
            </Card>
          ))
        )}
      </div>
    </motion.div>
  );
}
