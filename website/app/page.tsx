import { TelegramCommunity } from "./telegram-community";
import { Header, Hero, Features } from "./home-top";
import { HowItWorks, Install } from "./home-middle";
import { OpenSource, Plans, FAQ, Footer } from "./home-bottom";

export default function HomePage() {
 return <div className="page-shell" id="top"><div className="global-glow"/><Header/><main><Hero/><Features/><HowItWorks/><Install/><OpenSource/><Plans/><FAQ/><TelegramCommunity/></main><Footer/></div>;
}
