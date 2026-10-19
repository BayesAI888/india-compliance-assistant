import type { Metadata } from "next";
import "./admin.css";

export const metadata: Metadata = {
  title: "管理员后台",
  description: "印度合规助手知识库上传、审核与发布后台。",
};

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
