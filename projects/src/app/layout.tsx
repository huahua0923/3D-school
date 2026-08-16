import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: '场地路线图编辑器',
  description: '大型活动场地人流路线图编辑工具，支持导入场地图片、绘制路线、区域和文字标注',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.COZE_PROJECT_ENV === 'DEV';

  return (
    <html lang="zh-CN">
      <body className={`antialiased`}>
        {isDev && <Inspector />}
        {children}
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              background: '#1a1a2e',
              border: '1px solid #2a2a4e',
              color: '#e5e7eb',
              fontSize: '13px',
            },
          }}
        />
      </body>
    </html>
  );
}
