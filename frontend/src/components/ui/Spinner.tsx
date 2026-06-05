interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  xs: 'h-3 w-3 border',
  sm: 'h-4 w-4 border-2',
  md: 'h-7 w-7 border-2',
  lg: 'h-12 w-12 border-2',
};

const Spinner = ({ size = 'md', className = '' }: SpinnerProps) => (
  <div
    className={`animate-spin rounded-full border-gray-700 border-t-blue-500 ${sizeMap[size]} ${className}`}
  />
);

export default Spinner;
