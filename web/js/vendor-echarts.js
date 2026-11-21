// ECharts 按需构建：只注册本项目用到的图表与组件。
// 对比整包 1.0MB，按需后约 330KB（未压缩）；新增图表类型时在这里补 use()。
import * as echarts from "echarts/core";
import { LineChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  AxisPointerComponent,
  GraphicComponent,
  TitleComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  AxisPointerComponent,
  GraphicComponent,
  TitleComponent,
  CanvasRenderer,
]);

export default echarts;
export { echarts };
