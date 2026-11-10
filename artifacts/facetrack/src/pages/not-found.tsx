import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <>
      <div className="gx-aurora-page fixed inset-0 -z-10" aria-hidden="true" />
      <div className="relative min-h-screen w-full flex items-center justify-center bg-background text-foreground">
        <Card className="gx-panel w-full max-w-md mx-4">
          <CardContent className="pt-6">
            <div className="flex mb-4 gap-2 items-center">
              <AlertCircle className="h-8 w-8 text-red-400" />
              <h1 className="gx-title-gradient text-2xl font-bold">404 Page Not Found</h1>
            </div>

            <p className="mt-4 text-sm text-white/50">
              That route drifted off the aurora. Head back to the command center.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
