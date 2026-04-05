import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useGetMe, setAuthTokenGetter } from "@workspace/api-client-react";
import type { Admin } from "@workspace/api-client-react/src/generated/api.schemas";
import { useLocation } from "wouter";

interface AuthContextType {
  admin: Admin | null;
  isLoading: boolean;
  login: (token: string) => void;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(localStorage.getItem("ft_token"));
  const [, setLocation] = useLocation();

  const { data: admin, isLoading, error } = useGetMe({
    query: {
      enabled: !!token,
      retry: false,
    },
  });

  useEffect(() => {
    if (error) {
      logout();
    }
  }, [error]);

  const login = (newToken: string) => {
    localStorage.setItem("ft_token", newToken);
    setAuthTokenGetter(() => newToken);
    setToken(newToken);
  };

  const logout = () => {
    localStorage.removeItem("ft_token");
    setAuthTokenGetter(null);
    setToken(null);
    setLocation("/login");
  };

  return (
    <AuthContext.Provider
      value={{
        admin: admin || null,
        isLoading: token ? isLoading : false,
        login,
        logout,
        isAuthenticated: !!token && !!admin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
