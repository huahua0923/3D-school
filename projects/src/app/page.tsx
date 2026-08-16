import Toolbar from '@/components/editor/Toolbar';
import LayerPanel from '@/components/editor/LayerPanel';
import TopBar from '@/components/editor/TopBar';
import CanvasWrapper from '@/components/editor/CanvasWrapper';
import StatusBar from '@/components/editor/StatusBar';

export default function Home() {
  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <Toolbar />
        <CanvasWrapper />
        <LayerPanel />
      </div>
      <StatusBar />
    </div>
  );
}