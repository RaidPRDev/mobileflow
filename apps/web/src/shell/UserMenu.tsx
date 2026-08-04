import { useNavigate } from "react-router-dom";
import { UserCircle2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mobileflow/ui";
import { useAuth } from "../auth/AuthProvider";

export function UserMenu() {
  const navigate = useNavigate();
  const { me, signOut } = useAuth();

  const displayName =
    me?.user.name?.trim() ||
    me?.user.username ||
    me?.user.email?.split("@")[0] ||
    "Account";
  const initial = (displayName[0] ?? "?").toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="app-header-user-btn" aria-label="Account menu">
          {me?.user.avatarUrl ? (
            <img src={me.user.avatarUrl} alt="" className="app-header-user-avatar" />
          ) : (
            <UserCircle2 size={22} aria-hidden />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="user-menu">
        <div className="user-menu-identity">
          <span className="user-menu-avatar" aria-hidden>
            {me?.user.avatarUrl ? <img src={me.user.avatarUrl} alt="" /> : initial}
          </span>
          <div className="user-menu-identity-text">
            <div className="user-menu-name">{displayName}</div>
            {me?.user.email && <div className="user-menu-email">{me.user.email}</div>}
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/settings/account")}>
          Personal Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>Sign Out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
