import type { Variants } from "framer-motion";

const easeOutQuart = [0.25, 1, 0.5, 1] as const;

export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: easeOutQuart },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.4, ease: easeOutQuart },
  },
};

export const stagger: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08 },
  },
};

export const scaleOnHover: Variants = {
  rest: { scale: 1 },
  hover: {
    scale: 1.02,
    transition: { duration: 0.2, ease: easeOutQuart },
  },
};
