import { useState } from "react";
import type { FormEvent } from "react";
import { getStatus, setAuth, Unauthorized } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 版式取自 shadcn 官方 login block（居中卡片 + 表单）
export function Login({ onLogin }: { onLogin: () => void }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user.trim() || !pass) {
      setError("账号和密码不能为空");
      return;
    }
    setAuth(user.trim(), pass);
    try {
      await getStatus();
      onLogin();
    } catch (err) {
      if (err instanceof Unauthorized) setError("账号或密码错误");
      else setError(String(err));
    }
  };
  return (
    <div className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <img src="/logo.png" alt="Davflare" className="size-6" />
          Davflare Daemon
        </div>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">欢迎回来</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit}>
              <div className="grid gap-6">
                <div className="grid gap-3">
                  <Label htmlFor="mgmt-user">账号</Label>
                  <Input id="mgmt-user" value={user} onChange={(e) => setUser(e.target.value)} autoFocus />
                </div>
                <div className="grid gap-3">
                  <Label htmlFor="mgmt-pass">密码</Label>
                  <Input id="mgmt-pass" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
                </div>
                {error && <div className="text-destructive text-sm">{error}</div>}
                <Button type="submit" className="w-full">
                  登录
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
